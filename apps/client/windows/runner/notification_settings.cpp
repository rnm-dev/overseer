#include "notification_settings.h"

#include <flutter/standard_method_codec.h>
#include <shellapi.h>
#include <shlobj.h>
#include <propkey.h>
#include <propvarutil.h>
#include <winrt/Windows.UI.Notifications.h>

#include <filesystem>

namespace {
// Unpackaged desktop apps need a shell identity before Windows can report
// notification permission. The plugin separately registers its toast callback.
void RegisterNotificationIdentity() {
  constexpr auto app_id = L"org.ovrseer.app";
  winrt::check_hresult(SetCurrentProcessExplicitAppUserModelID(app_id));
  wchar_t executable[32768];
  const auto length = GetModuleFileNameW(nullptr, executable, 32768);
  if (length == 0 || length >= 32768) {
    winrt::throw_last_error();
  }
  PWSTR programs = nullptr;
  winrt::check_hresult(SHGetKnownFolderPath(FOLDERID_Programs, 0, nullptr, &programs));
  const auto shortcut = std::filesystem::path(programs) / L"Overseer Desktop.lnk";
  CoTaskMemFree(programs);

  winrt::com_ptr<IShellLinkW> link;
  winrt::check_hresult(CoCreateInstance(CLSID_ShellLink, nullptr,
      CLSCTX_INPROC_SERVER, IID_PPV_ARGS(link.put())));
  winrt::check_hresult(link->SetPath(executable));
  winrt::check_hresult(link->SetWorkingDirectory(
      std::filesystem::path(executable).parent_path().c_str()));
  winrt::check_hresult(link->SetDescription(L"Overseer desktop client"));
  auto properties = link.as<IPropertyStore>();
  PROPVARIANT identity;
  winrt::check_hresult(InitPropVariantFromString(app_id, &identity));
  const auto set_result = properties->SetValue(PKEY_AppUserModel_ID, identity);
  PropVariantClear(&identity);
  winrt::check_hresult(set_result);
  winrt::check_hresult(properties->Commit());
  winrt::check_hresult(link.as<IPersistFile>()->Save(shortcut.c_str(), TRUE));
}
}  // namespace

std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
CreateNotificationSettingsChannel(flutter::BinaryMessenger* messenger,
                                  HWND window) {
  auto channel =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          messenger, "dev.rnm.overseer/notification-settings",
          &flutter::StandardMethodCodec::GetInstance());
  channel->SetMethodCallHandler(
      [window](const auto& call, auto result) {
        try {
          if (call.method_name() == "register") {
            RegisterNotificationIdentity();
            result->Success();
          } else if (call.method_name() == "status") {
            using namespace winrt::Windows::UI::Notifications;
            const auto notifier =
                ToastNotificationManager::CreateToastNotifier(L"org.ovrseer.app");
            result->Success(flutter::EncodableValue(
                notifier.Setting() == NotificationSetting::Enabled));
          } else if (call.method_name() == "open") {
            const auto opened = reinterpret_cast<INT_PTR>(ShellExecuteW(
                window, L"open",
                L"ms-settings:notifications?appid=org.ovrseer.app",
                nullptr, nullptr, SW_SHOWNORMAL));
            result->Success(flutter::EncodableValue(opened > 32));
          } else if (call.method_name() == "activate") {
            ShowWindow(window, IsIconic(window) ? SW_RESTORE : SW_SHOW);
            SetForegroundWindow(window);
            result->Success();
          } else {
            result->NotImplemented();
          }
        } catch (const winrt::hresult_error& error) {
          // Windows creates the permission record on first delivery. A freshly
          // registered app has no Setting yet; this is not permission denial.
          if (call.method_name() == "status" &&
              error.code() == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
            result->Success();
            return;
          }
          result->Error("notification_settings", "Windows notification settings are unavailable.",
                        flutter::EncodableValue(static_cast<int32_t>(error.code())));
        }
      });
  return channel;
}
