import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { SECURE_FILE_HELPER } from "../../shared/runtimePrerequisites.js";

export const ATTACHMENT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const PROJECT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export interface ProjectFileRecord {
  dir: string;
}

export interface FileWriteResult {
  path: string;
  size: number;
  sha256: string;
}

export interface FileWriteTarget {
  rootReal: string;
  absPath: string;
  parentLexical: string;
  parentReal: string;
  parentDevice: number;
  parentInode: number;
  relativePath: string;
  name: string;
}

export class FileWriteError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FileWriteError";
  }
}

function withinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function fileWriteFsError(error: unknown, fallback = "safe file write failed"): FileWriteError {
  if (error instanceof FileWriteError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new FileWriteError(403, "FORBIDDEN", "destination is not writable");
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new FileWriteError(404, "PARENT_NOT_FOUND", "destination parent directory does not exist");
  }
  if (code === "EEXIST") {
    return new FileWriteError(409, "DESTINATION_EXISTS", "destination already exists");
  }
  return new FileWriteError(500, "WRITE_FAILED", fallback);
}

function relativeSegments(requested: string): string[] {
  const parts = requested.split("/");
  if (path.isAbsolute(requested) || path.win32.isAbsolute(requested) || parts.some((part) => part === "..")) {
    throw new FileWriteError(400, "PATH_ESCAPE", "file path escapes its allowed root");
  }
  if (!requested || parts.some((part) => !part || part === ".")) {
    throw new FileWriteError(400, "INVALID_PATH", "file path must name a file");
  }
  if (requested.includes("\\") || /[\0-\x1f\x7f]/.test(requested)) {
    throw new FileWriteError(400, "INVALID_PATH", "file path contains a malformed segment");
  }
  return parts;
}

function validateDestination(root: string, absPath: string): void {
  let destination;
  try {
    destination = lstatSync(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw fileWriteFsError(error, "failed to inspect upload destination");
  }
  if (destination.isSymbolicLink()) {
    try {
      const resolved = realpathSync(absPath);
      if (!withinRoot(root, resolved)) {
        throw new FileWriteError(400, "PATH_ESCAPE", "destination symlink escapes its allowed root");
      }
    } catch (error) {
      if (error instanceof FileWriteError) throw error;
    }
    throw new FileWriteError(400, "INVALID_PATH", "destination must be a regular file");
  }
  if (!destination.isFile()) {
    throw new FileWriteError(400, "INVALID_PATH", "destination must be a regular file");
  }
}

function targetFromExistingParent(root: string, parts: string[]): FileWriteTarget {
  const lexical = path.resolve(root, ...parts);
  if (!withinRoot(root, lexical) || lexical === root) {
    throw new FileWriteError(400, "PATH_ESCAPE", "file path escapes its allowed root");
  }
  const parentLexical = path.dirname(lexical);
  let parentReal: string;
  let parentStat;
  try {
    parentReal = realpathSync(parentLexical);
    parentStat = statSync(parentReal);
  } catch (error) {
    throw fileWriteFsError(error);
  }
  if (!withinRoot(root, parentReal)) {
    throw new FileWriteError(400, "PATH_ESCAPE", "destination parent escapes its allowed root");
  }
  if (!parentStat.isDirectory()) {
    throw new FileWriteError(404, "PARENT_NOT_FOUND", "destination parent directory does not exist");
  }
  const absPath = path.join(parentReal, path.basename(lexical));
  validateDestination(root, absPath);
  return {
    rootReal: root,
    absPath,
    parentLexical,
    parentReal,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    relativePath: parts.join("/"),
    name: path.basename(lexical),
  };
}

// `createParents` is opt-in because a plain project upload promises
// PARENT_NOT_FOUND for a path whose folder does not exist. Only a caller that
// says it is uploading a folder (the tree's directory drop) asks for the
// missing segments to be created, and they are created by the same contained
// walk the sandbox upload uses.
export function projectFileWriteTarget(record: ProjectFileRecord, requested: string, createParents = false): FileWriteTarget {
  const parts = relativeSegments(requested);
  let root: string;
  try {
    root = realpathSync(record.dir);
    if (!statSync(root).isDirectory()) throw new Error("project root is not a directory");
  } catch (error) {
    throw fileWriteFsError(error, "configured project root is unavailable");
  }
  if (createParents) createContainedParent(root, parts.slice(0, -1));
  return targetFromExistingParent(root, parts);
}

function createContainedParent(root: string, parts: string[]): void {
  let current = root;
  for (const segment of parts) {
    const candidate = path.join(current, segment);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        const resolved = realpathSync(candidate);
        if (!withinRoot(root, resolved)) throw new FileWriteError(400, "PATH_ESCAPE", "upload parent escapes the file transfer root");
        throw new FileWriteError(400, "INVALID_PATH", "upload parent cannot be a symlink");
      }
      if (!stat.isDirectory()) throw new FileWriteError(404, "PARENT_NOT_FOUND", "destination parent directory does not exist");
    } catch (error) {
      if (error instanceof FileWriteError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fileWriteFsError(error);
      try {
        mkdirSync(candidate);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw fileWriteFsError(mkdirError);
      }
      const created = lstatSync(candidate);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new FileWriteError(400, "INVALID_PATH", "upload parent is not a directory");
      }
    }
    current = candidate;
  }
}

export function sandboxFileWriteTarget(configuredRoot: string, requested: string): FileWriteTarget {
  if (!configuredRoot.trim()) {
    throw new FileWriteError(503, "FILES_DISABLED", "file transfer is disabled — set fileTransferRoot to enable it");
  }
  const parts = relativeSegments(requested);
  try {
    mkdirSync(configuredRoot, { recursive: true });
  } catch (error) {
    throw fileWriteFsError(error, "file transfer root is unavailable");
  }
  let root: string;
  try {
    root = realpathSync(configuredRoot);
    if (!statSync(root).isDirectory()) throw new Error("file transfer root is not a directory");
  } catch (error) {
    throw fileWriteFsError(error, "file transfer root is unavailable");
  }
  createContainedParent(root, parts.slice(0, -1));
  return targetFromExistingParent(root, parts);
}

export function revalidateFileWriteTarget(target: FileWriteTarget): void {
  let parentReal: string;
  let parentStat;
  try {
    parentReal = realpathSync(target.parentLexical);
    parentStat = statSync(parentReal);
  } catch (error) {
    throw fileWriteFsError(error);
  }
  if (
    parentReal !== target.parentReal
    || parentStat.dev !== target.parentDevice
    || parentStat.ino !== target.parentInode
    || !withinRoot(target.rootReal, parentReal)
  ) {
    throw new FileWriteError(400, "PATH_ESCAPE", "destination parent changed during upload");
  }
  validateDestination(target.rootReal, target.absPath);
}

interface AnchoredParent {
  handle: Awaited<ReturnType<typeof fs.open>>;
}

interface AnchoredProjectRoot extends AnchoredParent {
  device: bigint;
  inode: bigint;
}

async function openAnchoredParent(target: FileWriteTarget): Promise<AnchoredParent> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new FileWriteError(501, "UNSUPPORTED_PLATFORM", "secure file rename is unavailable on this platform");
  }
  const directoryFlags = constants.O_RDONLY
    | (constants.O_DIRECTORY ?? 0)
    | (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(target.parentReal, directoryFlags);
    const stat = await handle.stat();
    if (stat.dev !== target.parentDevice || stat.ino !== target.parentInode || !stat.isDirectory()) {
      await handle.close();
      throw new FileWriteError(400, "PATH_ESCAPE", "destination parent changed during file operation");
    }
  } catch (error) {
    throw fileWriteFsError(error, "failed to anchor destination parent");
  }
  return { handle };
}

async function openAnchoredProjectRoot(record: ProjectFileRecord): Promise<AnchoredProjectRoot> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new FileWriteError(501, "UNSUPPORTED_PLATFORM", "secure project move is unavailable on this platform");
  }
  let rootReal: string;
  let expected;
  try {
    // Resolve the mutable configured pathname exactly once. Every source and
    // destination operation after this point is relative to the resulting fd.
    rootReal = realpathSync(record.dir);
    expected = statSync(rootReal);
    if (!expected.isDirectory()) throw new Error("project root is not a directory");
  } catch (error) {
    throw fileWriteFsError(error, "configured project root is unavailable");
  }

  const directoryFlags = constants.O_RDONLY
    | (constants.O_DIRECTORY ?? 0)
    | (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(rootReal, directoryFlags);
    const actual = await handle.stat();
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new FileWriteError(400, "PATH_ESCAPE", "project root changed while it was being anchored");
    }
    return { handle, device: BigInt(actual.dev), inode: BigInt(actual.ino) };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw fileWriteFsError(error, "failed to anchor project root");
  }
}

const NATIVE_RENAME = String.raw`
import ctypes, errno, os, sys
src, dst, exclusive = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
expected_dev, expected_ino = int(sys.argv[4]), int(sys.argv[5])
try:
    current = os.stat(src, dir_fd=3, follow_symlinks=False)
except OSError as error:
    print(error.errno, file=sys.stderr)
    sys.exit(error.errno or 74)
if current.st_dev != expected_dev or current.st_ino != expected_ino:
    sys.exit(18)
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform.startswith("linux"):
    fn = getattr(libc, "renameat2", None)
    if fn is None:
        sys.exit(95)
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    result = fn(3, os.fsencode(src), 4, os.fsencode(dst), 1 if exclusive else 0)
elif sys.platform == "darwin":
    fn = getattr(libc, "renameatx_np", None)
    if fn is None:
        sys.exit(95)
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    result = fn(3, os.fsencode(src), 4, os.fsencode(dst), 0x00000004 if exclusive else 0)
else:
    sys.exit(95)
if result != 0:
    value = ctypes.get_errno()
    print(value, file=sys.stderr)
    sys.exit(17 if value == errno.EEXIST else 74)
`;

const NATIVE_PROJECT_MOVE = String.raw`
import ctypes, errno, os, stat, sys
mode, src_parent, src_name, dst_parent, dst_name = sys.argv[1:6]
root_dev, root_ino = int(sys.argv[6]), int(sys.argv[7])
expected_dev = int(sys.argv[8]) if len(sys.argv) > 8 else None
expected_ino = int(sys.argv[9]) if len(sys.argv) > 9 else None
directory_flags = os.O_RDONLY | os.O_DIRECTORY
if hasattr(os, "O_CLOEXEC"):
    directory_flags |= os.O_CLOEXEC

def fail(code, detail=None):
    if detail is not None:
        print(detail, file=sys.stderr)
    sys.exit(code)

def root_is_current():
    current = os.fstat(3)
    return current.st_dev == root_dev and current.st_ino == root_ino and stat.S_ISDIR(current.st_mode)

def beneath_root(fd):
    current = os.dup(fd)
    try:
        for _ in range(4096):
            current_stat = os.fstat(current)
            if current_stat.st_dev == root_dev and current_stat.st_ino == root_ino:
                return True
            parent = os.open("..", directory_flags | getattr(os, "O_NOFOLLOW", 0), dir_fd=current)
            parent_stat = os.fstat(parent)
            if parent_stat.st_dev == current_stat.st_dev and parent_stat.st_ino == current_stat.st_ino:
                os.close(parent)
                return False
            os.close(current)
            current = parent
        return False
    finally:
        os.close(current)

def open_parent(relative):
    value = relative or "."
    try:
        if sys.platform.startswith("linux"):
            class OpenHow(ctypes.Structure):
                _fields_ = [
                    ("flags", ctypes.c_ulonglong),
                    ("mode", ctypes.c_ulonglong),
                    ("resolve", ctypes.c_ulonglong),
                ]
            how = OpenHow(directory_flags, 0, 0x08 | 0x02)
            libc = ctypes.CDLL(None, use_errno=True)
            libc.syscall.restype = ctypes.c_long
            fd = libc.syscall(437, 3, os.fsencode(value), ctypes.byref(how), ctypes.sizeof(how))
            if fd < 0:
                value_errno = ctypes.get_errno()
                if value_errno in (errno.ENOSYS, errno.EINVAL):
                    fail(95)
                if value_errno in (errno.EXDEV, errno.ELOOP):
                    fail(20)
                if value_errno in (errno.ENOENT, errno.ENOTDIR):
                    fail(23)
                fail(74, value_errno)
        elif sys.platform == "darwin":
            fd = os.open(value, directory_flags, dir_fd=3)
        else:
            fail(95)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            fail(23)
        fail(74, error.errno)
    if not beneath_root(fd):
        os.close(fd)
        fail(20)
    return fd

def reject_symlink(relative):
    entry_flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0)
    if hasattr(os, "O_CLOEXEC"):
        entry_flags |= os.O_CLOEXEC
    try:
        if sys.platform.startswith("linux"):
            class OpenHow(ctypes.Structure):
                _fields_ = [
                    ("flags", ctypes.c_ulonglong),
                    ("mode", ctypes.c_ulonglong),
                    ("resolve", ctypes.c_ulonglong),
                ]
            how = OpenHow(entry_flags, 0, 0x08 | 0x02)
            libc = ctypes.CDLL(None, use_errno=True)
            libc.syscall.restype = ctypes.c_long
            fd = libc.syscall(437, 3, os.fsencode(relative), ctypes.byref(how), ctypes.sizeof(how))
            if fd < 0:
                value_errno = ctypes.get_errno()
                if value_errno in (errno.EXDEV, errno.ELOOP):
                    fail(20)
                if value_errno in (errno.ENOSYS, errno.EINVAL):
                    fail(95)
                fail(22)
        elif sys.platform == "darwin":
            fd = os.open(relative, entry_flags, dir_fd=3)
            libc = ctypes.CDLL(None, use_errno=True)
            root_path = ctypes.create_string_buffer(1024)
            entry_path = ctypes.create_string_buffer(1024)
            if libc.fcntl(3, 50, root_path) != 0 or libc.fcntl(fd, 50, entry_path) != 0:
                os.close(fd)
                fail(20)
            root_value = os.fsdecode(root_path.value)
            entry_value = os.fsdecode(entry_path.value)
            if os.path.commonpath([root_value, entry_value]) != root_value:
                os.close(fd)
                fail(20)
        else:
            fail(95)
    except OSError:
        fail(22)
    os.close(fd)
    fail(22)

if not root_is_current():
    fail(20)
source_parent_fd = open_parent(src_parent)
destination_parent_fd = open_parent(dst_parent)
try:
    if not root_is_current() or not beneath_root(source_parent_fd) or not beneath_root(destination_parent_fd):
        fail(20)
    try:
        source = os.stat(src_name, dir_fd=source_parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        fail(21)
    if stat.S_ISLNK(source.st_mode):
        reject_symlink(f"{src_parent}/{src_name}" if src_parent else src_name)
    if not stat.S_ISREG(source.st_mode) and not stat.S_ISDIR(source.st_mode):
        fail(22)
    try:
        destination = os.stat(dst_name, dir_fd=destination_parent_fd, follow_symlinks=False)
        if stat.S_ISLNK(destination.st_mode):
            reject_symlink(f"{dst_parent}/{dst_name}" if dst_parent else dst_name)
        if not stat.S_ISREG(destination.st_mode) and not stat.S_ISDIR(destination.st_mode):
            fail(22)
        fail(17)
    except FileNotFoundError:
        pass
    if mode == "inspect":
        sys.stdout.write(f"{source.st_dev}:{source.st_ino}:{source.st_size}\n")
        sys.stdout.flush()
        sys.exit(0)
    if expected_dev is None or source.st_dev != expected_dev or source.st_ino != expected_ino:
        fail(18)
    if not root_is_current() or not beneath_root(source_parent_fd) or not beneath_root(destination_parent_fd):
        fail(20)
    current = os.stat(src_name, dir_fd=source_parent_fd, follow_symlinks=False)
    if current.st_dev != expected_dev or current.st_ino != expected_ino:
        fail(18)
    if not stat.S_ISREG(current.st_mode) and not stat.S_ISDIR(current.st_mode):
        fail(18)
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux"):
        fn = getattr(libc, "renameat2", None)
        if fn is None:
            fail(95)
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        result = fn(source_parent_fd, os.fsencode(src_name), destination_parent_fd, os.fsencode(dst_name), 1)
    elif sys.platform == "darwin":
        fn = getattr(libc, "renameatx_np", None)
        if fn is None:
            fail(95)
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        result = fn(source_parent_fd, os.fsencode(src_name), destination_parent_fd, os.fsencode(dst_name), 0x00000004)
    else:
        fail(95)
    if result != 0:
        value_errno = ctypes.get_errno()
        if value_errno in (errno.EEXIST, errno.ENOTEMPTY):
            fail(17)
        # The kernel is the authority on "a folder cannot be moved inside
        # itself"; it answers EINVAL, which would otherwise read as a generic
        # write failure.
        if value_errno == errno.EINVAL:
            fail(24)
        fail(74, value_errno)
finally:
    os.close(source_parent_fd)
    os.close(destination_parent_fd)
`;

const NATIVE_PROJECT_DELETE = String.raw`
import ctypes, errno, os, stat, sys
parent_path, name = sys.argv[1:3]
root_dev, root_ino = int(sys.argv[3]), int(sys.argv[4])
directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)

def fail(code):
    sys.exit(code)

libc = ctypes.CDLL(None, use_errno=True)
if sys.platform.startswith("linux"):
    class OpenHow(ctypes.Structure):
        _fields_ = [
            ("flags", ctypes.c_ulonglong),
            ("mode", ctypes.c_ulonglong),
            ("resolve", ctypes.c_ulonglong),
        ]
    libc.syscall.restype = ctypes.c_long
    how = OpenHow(directory_flags, 0, 0x08 | 0x02)
    parent_fd = libc.syscall(437, 3, os.fsencode(parent_path or "."), ctypes.byref(how), ctypes.sizeof(how))
    if parent_fd < 0:
        value = ctypes.get_errno()
        if value in (errno.ENOSYS, errno.EINVAL):
            fail(95)
        if value in (errno.EXDEV, errno.ELOOP):
            fail(20)
        if value in (errno.ENOENT, errno.ENOTDIR):
            fail(23)
        fail(74)
elif sys.platform == "darwin":
    try:
        parent_fd = os.open(parent_path or ".", directory_flags, dir_fd=3)
    except FileNotFoundError:
        fail(23)
    cursor = os.dup(parent_fd)
    contained = False
    try:
        for _ in range(4096):
            current = os.fstat(cursor)
            if current.st_dev == root_dev and current.st_ino == root_ino:
                contained = True
                break
            ancestor = os.open("..", directory_flags, dir_fd=cursor)
            ancestor_stat = os.fstat(ancestor)
            if ancestor_stat.st_dev == current.st_dev and ancestor_stat.st_ino == current.st_ino:
                os.close(ancestor)
                break
            os.close(cursor)
            cursor = ancestor
    finally:
        os.close(cursor)
    if not contained:
        os.close(parent_fd)
        fail(20)
else:
    fail(95)
try:
    root = os.fstat(3)
    if root.st_dev != root_dev or root.st_ino != root_ino or not stat.S_ISDIR(root.st_mode):
        fail(20)
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        fail(21)
    if not stat.S_ISREG(before.st_mode):
        fail(22)
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if current.st_dev != before.st_dev or current.st_ino != before.st_ino or not stat.S_ISREG(current.st_mode):
        fail(18)
    os.unlink(name, dir_fd=parent_fd)
    os.fsync(parent_fd)
    sys.stdout.write(str(before.st_size))
finally:
    os.close(parent_fd)
`;

interface AnchoredMoveSelection {
  sourceParent: string;
  sourceName: string;
  destinationParent: string;
  destinationName: string;
  destinationPath: string;
}

function anchoredMoveSelection(sourcePath: string, destinationPath: string): AnchoredMoveSelection {
  const source = relativeSegments(sourcePath);
  const destination = relativeSegments(destinationPath);
  const normalizedSource = source.join("/");
  const normalizedDestination = destination.join("/");
  if (normalizedSource === normalizedDestination) {
    throw new FileWriteError(400, "INVALID_PATH", "source and destination must differ");
  }
  return {
    sourceParent: source.slice(0, -1).join("/"),
    sourceName: source.at(-1)!,
    destinationParent: destination.slice(0, -1).join("/"),
    destinationName: destination.at(-1)!,
    destinationPath: normalizedDestination,
  };
}

async function runAnchoredProjectMove(
  root: AnchoredProjectRoot,
  selection: AnchoredMoveSelection,
  expectedSource?: { device: bigint; inode: bigint },
): Promise<{ device: bigint; inode: bigint; size: number } | null> {
  const inspect = expectedSource === undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(SECURE_FILE_HELPER, [
      "-c",
      NATIVE_PROJECT_MOVE,
      inspect ? "inspect" : "commit",
      selection.sourceParent,
      selection.sourceName,
      selection.destinationParent,
      selection.destinationName,
      root.device.toString(),
      root.inode.toString(),
      ...(expectedSource ? [expectedSource.device.toString(), expectedSource.inode.toString()] : []),
    ], {
      stdio: ["ignore", "pipe", "pipe", root.handle.fd],
    });
    let output = "";
    let error = "";
    child.stdout?.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-256); });
    child.stderr?.on("data", (chunk) => { error = `${error}${String(chunk)}`.slice(-256); });
    child.once("error", () => reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native secure project move helper is unavailable")));
    child.once("exit", (code) => {
      if (code === 0) {
        if (!inspect) return resolve(null);
        const match = /^(\d+):(\d+):(\d+)\n?$/.exec(output);
        if (!match) return reject(new FileWriteError(500, "WRITE_FAILED", "native project move helper returned invalid metadata"));
        return resolve({ device: BigInt(match[1]!), inode: BigInt(match[2]!), size: Number(match[3]!) });
      }
      if (code === 17) return reject(new FileWriteError(409, "DESTINATION_EXISTS", "destination already exists"));
      if (code === 18) return reject(new FileWriteError(409, "SOURCE_CHANGED", "source changed during commit"));
      if (code === 20) return reject(new FileWriteError(400, "PATH_ESCAPE", "project move left its anchored project root"));
      if (code === 21) return reject(new FileWriteError(404, "NOT_FOUND", "source file does not exist"));
      if (code === 22) return reject(new FileWriteError(400, "INVALID_PATH", "source must be a regular file or a directory"));
      if (code === 23) return reject(new FileWriteError(404, "PARENT_NOT_FOUND", "source or destination parent directory does not exist"));
      if (code === 24) return reject(new FileWriteError(400, "INVALID_PATH", "a directory cannot be moved inside itself"));
      if (code === 95) return reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native contained no-replace rename is unavailable"));
      return reject(new FileWriteError(500, "WRITE_FAILED", `native contained project move failed${error.trim() ? ` (${error.trim()})` : ""}`));
    });
  });
}

async function anchoredRename(
  source: AnchoredParent,
  sourceName: string,
  destination: AnchoredParent,
  destinationName: string,
  exclusive: boolean,
  expectedSource: { device: bigint; inode: bigint },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(SECURE_FILE_HELPER, [
      "-c",
      NATIVE_RENAME,
      sourceName,
      destinationName,
      exclusive ? "1" : "0",
      expectedSource.device.toString(),
      expectedSource.inode.toString(),
    ], {
      stdio: ["ignore", "ignore", "pipe", source.handle.fd, destination.handle.fd],
    });
    let error = "";
    child.stderr?.on("data", (chunk) => { error = `${error}${String(chunk)}`.slice(-256); });
    child.once("error", () => reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native secure rename helper is unavailable")));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else if (code === 17) reject(new FileWriteError(409, "DESTINATION_EXISTS", "destination already exists"));
      else if (code === 18) reject(new FileWriteError(409, "SOURCE_CHANGED", "source changed during commit"));
      else if (code === 95) reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native no-replace rename is unavailable"));
      else reject(new FileWriteError(500, "WRITE_FAILED", `native secure rename failed${error.trim() ? ` (${error.trim()})` : ""}`));
    });
  });
}

async function anchoredUnlink(parent: AnchoredParent, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const code = "import errno, os, sys\ntry:\n os.unlink(sys.argv[1], dir_fd=3)\nexcept OSError as error:\n sys.exit(0 if error.errno == errno.ENOENT else 74)";
    const child = spawn(SECURE_FILE_HELPER, ["-c", code, name], {
      stdio: ["ignore", "ignore", "ignore", parent.handle.fd],
    });
    child.once("error", () => reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native secure unlink helper is unavailable")));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new FileWriteError(500, "WRITE_FAILED", "native secure temporary cleanup failed"));
    });
  });
}

async function fsyncAnchoredDirectory(parent: AnchoredParent): Promise<void> {
  try {
    await parent.handle.sync();
  } catch (error) {
    throw fileWriteFsError(error, "failed to persist destination directory");
  }
}

const NATIVE_TEMP_WRITER = String.raw`
import errno, os, sys
name = sys.argv[1]
if not hasattr(os, "O_NOFOLLOW"):
    sys.exit(95)
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
try:
    fd = os.open(name, flags, 0o666, dir_fd=3)
    stat = os.fstat(fd)
    sys.stdout.write(f"{stat.st_dev}:{stat.st_ino}\n")
    sys.stdout.flush()
    while True:
        chunk = os.read(0, 65536)
        if not chunk:
            break
        offset = 0
        while offset < len(chunk):
            written = os.write(fd, chunk[offset:])
            if written == 0:
                raise OSError(errno.EIO, "zero-byte file write")
            offset += written
    os.fsync(fd)
    os.close(fd)
except OSError as error:
    print(error.errno, file=sys.stderr)
    sys.exit(17 if error.errno == errno.EEXIST else 74)
`;

interface AnchoredTemporaryWriter {
  child: ReturnType<typeof spawn>;
  completion: Promise<void>;
  identity: { device: bigint; inode: bigint };
}

async function openAnchoredTemporary(
  parent: AnchoredParent,
  name: string,
): Promise<AnchoredTemporaryWriter> {
  const child = spawn(SECURE_FILE_HELPER, ["-c", NATIVE_TEMP_WRITER, name], {
    stdio: ["pipe", "pipe", "pipe", parent.handle.fd],
  });
  let error = "";
  child.stderr?.on("data", (chunk) => { error = `${error}${String(chunk)}`.slice(-256); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native anchored temporary helper is unavailable")));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else if (code === 17) reject(new FileWriteError(409, "DESTINATION_EXISTS", "temporary destination already exists"));
      else if (code === 95) reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native anchored temporary creation is unavailable"));
      else reject(new FileWriteError(500, "WRITE_FAILED", `native anchored temporary helper failed${error.trim() ? ` (${error.trim()})` : ""}`));
    });
  });
  void completion.catch(() => {});
  const identity = await new Promise<{ device: bigint; inode: bigint }>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output = `${output}${String(chunk)}`;
      if (output.length > 128) {
        child.kill();
        reject(new FileWriteError(500, "WRITE_FAILED", "native anchored temporary helper returned invalid metadata"));
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const match = /^(\d+):(\d+)$/.exec(output.slice(0, newline));
      if (!match) {
        child.kill();
        reject(new FileWriteError(500, "WRITE_FAILED", "native anchored temporary helper returned invalid metadata"));
        return;
      }
      resolve({ device: BigInt(match[1]!), inode: BigInt(match[2]!) });
    };
    child.stdout?.on("data", onData);
    completion.catch(reject);
  }).catch(async (failure) => {
    child.stdin?.destroy();
    child.kill();
    await completion.catch(() => {});
    throw failure;
  });
  return { child, completion, identity };
}

export interface AtomicFileUploadOpenOptions {
  beforeTemporaryOpen?: () => void | Promise<void>;
  afterTemporaryOpen?: () => void | Promise<void>;
}

export class AtomicFileUpload {
  private writer: AnchoredTemporaryWriter | null = null;
  private readonly hash = createHash("sha256");
  private readonly temporaryName: string;
  private bytes = 0;
  private committed = false;

  private constructor(
    private readonly target: FileWriteTarget,
    private readonly maxBytes: number,
    private readonly claimedSha256: string | null,
    private parent: AnchoredParent | null,
    writer: AnchoredTemporaryWriter,
    temporaryName: string,
  ) {
    this.writer = writer;
    this.temporaryName = temporaryName;
  }

  static async open(
    target: FileWriteTarget,
    maxBytes: number,
    claimedSha256: string | null,
    options: AtomicFileUploadOpenOptions = {},
  ): Promise<AtomicFileUpload> {
    const temporaryName = `.${target.name}.peon-upload-${randomUUID()}`;
    let parent: AnchoredParent | null = null;
    let writer: AnchoredTemporaryWriter | null = null;
    try {
      parent = await openAnchoredParent(target);
      await options.beforeTemporaryOpen?.();
      writer = await openAnchoredTemporary(parent, temporaryName);
      await options.afterTemporaryOpen?.();
      return new AtomicFileUpload(target, maxBytes, claimedSha256, parent, writer, temporaryName);
    } catch (error) {
      let cleanupError: unknown;
      if (writer) {
        writer.child.stdin?.destroy();
        writer.child.kill();
        await writer.completion.catch(() => {});
      }
      if (parent) {
        try {
          await anchoredUnlink(parent, temporaryName);
        } catch (failure) {
          cleanupError = failure;
        }
        await parent.handle.close().catch(() => {});
      }
      if (cleanupError) throw fileWriteFsError(cleanupError);
      throw fileWriteFsError(error);
    }
  }

  get size(): number {
    return this.bytes;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.writer?.child.stdin) throw new FileWriteError(409, "TRANSFER_CLOSED", "upload is no longer active");
    if (chunk.byteLength === 0) throw new FileWriteError(400, "INVALID_CHUNK", "upload chunk must not be empty");
    if (this.bytes + chunk.byteLength > this.maxBytes) {
      throw new FileWriteError(413, "FILE_TOO_LARGE", `file exceeds ${this.maxBytes / (1024 * 1024)}MB limit`);
    }
    const bytes = Buffer.from(chunk);
    await new Promise<void>((resolve, reject) => {
      this.writer!.child.stdin!.write(bytes, (error) => error ? reject(error) : resolve());
    });
    this.hash.update(bytes);
    this.bytes += bytes.length;
  }

  async complete(expectedBytes?: number): Promise<FileWriteResult> {
    if (!this.writer?.child.stdin) throw new FileWriteError(409, "TRANSFER_CLOSED", "upload is no longer active");
    if (expectedBytes !== undefined && this.bytes !== expectedBytes) {
      throw new FileWriteError(409, "LENGTH_MISMATCH", "upload length does not match the declared content length");
    }
    try {
      const writer = this.writer;
      this.writer = null;
      const input = writer.child.stdin;
      if (!input) throw new FileWriteError(409, "TRANSFER_CLOSED", "upload is no longer active");
      input.end();
      await writer.completion;
      const sha256 = this.hash.digest("hex");
      if (this.claimedSha256 && this.claimedSha256 !== sha256) {
        throw new FileWriteError(409, "CHECKSUM_MISMATCH", "upload checksum does not match the claimed SHA-256");
      }
      if (!this.parent) throw new FileWriteError(500, "WRITE_FAILED", "upload parent anchor is unavailable");
      // This check makes an already-swapped lexical parent fail explicitly.
      // The fd-relative rename below remains the security boundary if the
      // pathname changes after this check.
      revalidateFileWriteTarget(this.target);
      await anchoredRename(
        this.parent,
        this.temporaryName,
        this.parent,
        this.target.name,
        false,
        writer.identity,
      );
      await fsyncAnchoredDirectory(this.parent);
      this.committed = true;
      return { path: this.target.relativePath, size: this.bytes, sha256 };
    } catch (error) {
      throw fileWriteFsError(error);
    } finally {
      if (!this.committed) await this.cleanupTemporary();
      await this.closeParent();
    }
  }

  async cancel(): Promise<void> {
    if (this.writer) {
      const writer = this.writer;
      this.writer = null;
      writer.child.stdin?.destroy();
      writer.child.kill();
      await writer.completion.catch(() => {});
    }
    if (!this.committed) await this.cleanupTemporary();
    await this.closeParent();
  }

  private async cleanupTemporary(): Promise<void> {
    if (this.parent) await anchoredUnlink(this.parent, this.temporaryName);
  }

  private async closeParent(): Promise<void> {
    if (!this.parent) return;
    const parent = this.parent;
    this.parent = null;
    await parent.handle.close().catch(() => {});
  }
}

export async function moveProjectFile(
  record: ProjectFileRecord,
  sourcePath: string,
  destinationPath: string,
  options: {
    afterProjectRootOpen?: () => void | Promise<void>;
    beforeCommit?: () => void | Promise<void>;
  } = {},
): Promise<{ path: string; size: number }> {
  const selection = anchoredMoveSelection(sourcePath, destinationPath);
  let root: AnchoredProjectRoot | null = null;
  try {
    root = await openAnchoredProjectRoot(record);
    await options.afterProjectRootOpen?.();
    const source = await runAnchoredProjectMove(root, selection);
    if (!source) throw new FileWriteError(500, "WRITE_FAILED", "project move source inspection failed");
    await options.beforeCommit?.();
    await runAnchoredProjectMove(root, selection, source);
    return { path: selection.destinationPath, size: source.size };
  } catch (error) {
    throw fileWriteFsError(error, "safe project file move failed");
  } finally {
    await root?.handle.close().catch(() => {});
  }
}

export async function deleteProjectFile(
  record: ProjectFileRecord,
  relativePath: string,
): Promise<{ path: string; size: number }> {
  const parts = relativeSegments(relativePath);
  const normalizedPath = parts.join("/");
  let root: AnchoredProjectRoot | null = null;
  try {
    root = await openAnchoredProjectRoot(record);
    const size = await new Promise<number>((resolve, reject) => {
      const child = spawn(SECURE_FILE_HELPER, [
        "-c",
        NATIVE_PROJECT_DELETE,
        parts.slice(0, -1).join("/"),
        parts.at(-1)!,
        root!.device.toString(),
        root!.inode.toString(),
      ], { stdio: ["ignore", "pipe", "ignore", root!.handle.fd] });
      let output = "";
      child.stdout?.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-64); });
      child.once("error", () => reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native secure project delete helper is unavailable")));
      child.once("exit", (code) => {
        if (code === 0 && /^\d+$/.test(output)) return resolve(Number(output));
        if (code === 18) return reject(new FileWriteError(409, "SOURCE_CHANGED", "delete target changed during commit"));
        if (code === 20) return reject(new FileWriteError(400, "PATH_ESCAPE", "project delete left its anchored project root"));
        if (code === 21) return reject(new FileWriteError(404, "NOT_FOUND", "file does not exist"));
        if (code === 22) return reject(new FileWriteError(400, "INVALID_PATH", "delete target must be a regular file"));
        if (code === 23) return reject(new FileWriteError(404, "PARENT_NOT_FOUND", "delete target parent directory does not exist"));
        if (code === 95) return reject(new FileWriteError(501, "UNSUPPORTED_PLATFORM", "native contained delete is unavailable"));
        reject(new FileWriteError(500, "WRITE_FAILED", "native contained project delete failed"));
      });
    });
    return { path: normalizedPath, size };
  } catch (error) {
    throw fileWriteFsError(error, "safe project file delete failed");
  } finally {
    await root?.handle.close().catch(() => {});
  }
}
