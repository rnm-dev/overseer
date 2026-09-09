#ifndef RUNNER_NOTIFICATION_SETTINGS_H_
#define RUNNER_NOTIFICATION_SETTINGS_H_

#include <flutter/method_channel.h>
#include <flutter/encodable_value.h>
#include <windows.h>

#include <memory>

std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
CreateNotificationSettingsChannel(flutter::BinaryMessenger* messenger,
                                  HWND window);

#endif
