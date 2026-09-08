use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 64 * 1024;

fn runtime_path(resources: &Path) -> PathBuf {
    let path = resources.join("runtime");
    #[cfg(windows)]
    {
        // Tauri returns a verbatim `\\?\` resource path on Windows. Node 22's
        // entry-point resolver misparses that form and exits before loading the
        // script, so pass its equivalent conventional path instead.
        dunce::simplified(&path).to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

#[cfg(windows)]
struct Job(isize);
#[cfg(windows)]
impl Job {
    fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("Cannot create a Windows process job".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                CloseHandle(handle);
                return Err("Cannot contain Peon's Windows process tree".into());
            }
            Ok(Self(handle as isize))
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

pub struct Runtime {
    child: Child,
    input: ChildStdin,
    replies: Receiver<Value>,
    next_id: u64,
    #[cfg(windows)]
    _job: Job,
}

impl Runtime {
    pub fn start(resources: &Path) -> Result<Self, String> {
        let runtime = runtime_path(resources);
        let node = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
        let script = runtime.join("node_modules/@rnm-dev/peon/dist/desktop/peon.js");
        if !node.is_file() || !script.is_file() {
            return Err("Bundled Peon runtime is missing. Reinstall Peon.".into());
        }
        let mut command = Command::new(&node);
        command
            .arg(script)
            .current_dir(&runtime)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start bundled Node runtime")?;
        #[cfg(windows)]
        let job = match Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child.stdin.take().ok_or("Missing runtime input pipe")?;
        let stdout = child.stdout.take().ok_or("Missing runtime output pipe")?;
        let (tx, replies) = mpsc::sync_channel(16);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut frame = Vec::new();
                match reader
                    .by_ref()
                    .take((MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut frame)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if frame.len() > MAX_FRAME || frame.last() != Some(&b'\n') {
                    break;
                }
                match serde_json::from_slice(&frame) {
                    Ok(value) => {
                        if tx.try_send(value).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut result = Self {
            child,
            input,
            replies,
            next_id: 0,
            #[cfg(windows)]
            _job: job,
        };
        let hello = result.request(
            "initialize",
            json!({"protocol": 1}),
            Duration::from_secs(90),
        )?;
        if hello["protocol"] != 1 || hello["pid"] != result.child.id() {
            return Err("Incompatible Peon runtime".into());
        }
        Ok(result)
    }

    pub fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let request = json!({"id": self.next_id, "method": method, "params": params});
        let mut encoded = serde_json::to_vec(&request).map_err(|_| "Invalid request")?;
        encoded.push(b'\n');
        if encoded.len() > MAX_FRAME {
            return Err("Request is too large".into());
        }
        self.input
            .write_all(&encoded)
            .map_err(|_| "Peon has stopped")?;
        self.input.flush().map_err(|_| "Peon has stopped")?;
        let response = self
            .replies
            .recv_timeout(timeout)
            .map_err(|_| "Peon did not answer in time")?;
        if response["id"] != self.next_id {
            return Err("Stale Peon reply; restart required".into());
        }
        if let Some(error) = response["error"].as_str() {
            return Err(error.to_string());
        }
        Ok(response["result"].clone())
    }

    pub fn stop(&mut self, force: bool) -> Result<(), String> {
        if self.exited() {
            return Ok(());
        }
        self.request("shutdown", json!({"force": force}), Duration::from_secs(5))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if !self.exited() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        Ok(())
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Normal paths call stop first. On failure/crash the Windows job also
        // closes, including descendants; only this Child handle is killed here.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct Controller {
    runtime: Option<Runtime>,
    log: Vec<String>,
}
impl Controller {
    fn note(&mut self, message: &str) {
        if self.log.len() == 100 {
            self.log.remove(0);
        }
        self.log.push(message.into());
    }
    pub fn call(&mut self, resources: &Path, method: &str, params: Value) -> Result<Value, String> {
        if self
            .runtime
            .as_mut()
            .is_some_and(|runtime| runtime.exited())
        {
            self.runtime = None;
            self.note("Peon stopped unexpectedly. Start it again to recover your sessions.");
        }
        match method {
            "start" => {
                if self.runtime.is_none() {
                    self.runtime = Some(Runtime::start(resources)?);
                    self.note("Peon started.");
                }
            }
            "stop" | "restart" | "quit" => {
                if let Some(runtime) = &mut self.runtime {
                    runtime.stop(params["force"] == true)?;
                }
                self.runtime = None;
                self.note("Peon stopped.");
                if method == "restart" {
                    self.runtime = Some(Runtime::start(resources)?);
                    self.note("Peon restarted.");
                }
            }
            "logs" => return Ok(json!(self.log)),
            "status" => {}
            "enroll" | "configure" => {
                let runtime = self.runtime.as_mut().ok_or("Start Peon first")?;
                return runtime.request(method, params, Duration::from_secs(10));
            }
            _ => return Err("Unknown controller command".into()),
        }
        if let Some(runtime) = &mut self.runtime {
            let mut result = runtime.request("status", Value::Null, Duration::from_secs(10))?;
            result["running"] = Value::Bool(true);
            Ok(result)
        } else {
            Ok(json!({"running": false}))
        }
    }
}

#[cfg(windows)]
pub fn autostart(enabled: Option<bool>) -> Result<bool, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|_| "Cannot access start-at-login settings")?;
    let executable = std::env::current_exe().map_err(|_| "Cannot locate Peon")?;
    let expected = format!("\"{}\" --background", executable.display());
    match enabled {
        Some(true) => key
            .set_value("PeonDesktop", &expected)
            .map_err(|_| "Cannot enable start at login")?,
        Some(false) => {
            if key.get_value::<String, _>("PeonDesktop").is_ok() {
                key.delete_value("PeonDesktop")
                    .map_err(|_| "Cannot disable start at login")?;
            }
        }
        None => {}
    }
    Ok(key.get_value::<String, _>("PeonDesktop").ok().as_deref() == Some(&expected))
}

#[cfg(not(windows))]
pub fn autostart(_: Option<bool>) -> Result<bool, String> {
    Err("Start at login is available on Windows".into())
}
