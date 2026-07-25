import ActivityKit
import Flutter
import Foundation

@available(iOS 16.2, *)
struct OverseerSessionAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let title: String
    let activeCount: Int?
    let projectName: String?
    let detail: String?
    let phase: String
    let startedAt: Date?
    let updatedAt: Date
  }

  let activityId: String
  let workspaceId: String
  let peonId: String
  let sessionId: String
}

final class SessionActivityPlugin {
  private static let channelName = "dev.rnm.overseer/session-activities"
  private static var channel: FlutterMethodChannel?
  private static var observedActivityIds = Set<String>()

  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: channelName,
      binaryMessenger: registrar.messenger()
    )
    self.channel = channel
    channel.setMethodCallHandler { call, result in
      guard call.method == "synchronize" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard #available(iOS 16.2, *), ActivityAuthorizationInfo().areActivitiesEnabled else {
        result(nil)
        return
      }
      let arguments = call.arguments as? [String: Any]
      let activities = arguments?["activities"] as? [[String: Any]] ?? []
      Task { @MainActor in
        do {
          try await synchronize(activities)
          result(nil)
        } catch {
          result(
            FlutterError(
              code: "SESSION_ACTIVITY_SYNC_FAILED",
              message: error.localizedDescription,
              details: nil
            )
          )
        }
      }
    }
  }

  @available(iOS 16.2, *)
  @MainActor
  private static func synchronize(_ payloads: [[String: Any]]) async throws {
    let desired = Dictionary(
      uniqueKeysWithValues: payloads.compactMap { payload -> (String, [String: Any])? in
        guard let activityId = payload["activityId"] as? String else { return nil }
        return (activityId, payload)
      }
    )
    let existing = Dictionary(
      uniqueKeysWithValues: Activity<OverseerSessionAttributes>.activities.map {
        ($0.attributes.activityId, $0)
      }
    )

    for (activityId, activity) in existing where desired[activityId] == nil {
      let current = activity.content.state
      let finalState = OverseerSessionAttributes.ContentState(
        title: current.title,
        activeCount: current.activeCount,
        projectName: current.projectName,
        detail: "Run ended",
        phase: "ended",
        startedAt: current.startedAt,
        updatedAt: Date()
      )
      await activity.end(
        ActivityContent(state: finalState, staleDate: nil),
        dismissalPolicy: .after(Date().addingTimeInterval(90))
      )
    }

    for (activityId, payload) in desired {
      guard let content = contentState(payload) else { continue }
      let activityContent = ActivityContent(state: content, staleDate: nil)
      if let activity = existing[activityId] {
        await activity.update(activityContent)
        observePushToken(activity)
        continue
      }
      guard
        let workspaceId = payload["workspaceId"] as? String,
        let peonId = payload["peonId"] as? String,
        let sessionId = payload["sessionId"] as? String
      else { continue }
      let attributes = OverseerSessionAttributes(
        activityId: activityId,
        workspaceId: workspaceId,
        peonId: peonId,
        sessionId: sessionId
      )
      let activity = try Activity.request(
        attributes: attributes,
        content: activityContent,
        pushType: .token
      )
      observePushToken(activity)
    }
  }

  @available(iOS 16.2, *)
  private static func observePushToken(
    _ activity: Activity<OverseerSessionAttributes>
  ) {
    guard observedActivityIds.insert(activity.id).inserted else { return }
    Task {
      for await tokenData in activity.pushTokenUpdates {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        await MainActor.run {
          channel?.invokeMethod(
            "pushTokenChanged",
            arguments: [
              "activityId": activity.id,
              "workspaceId": activity.attributes.workspaceId,
              "peonId": activity.attributes.peonId,
              "sessionId": activity.attributes.sessionId,
              "token": token,
            ]
          )
        }
      }
      _ = observedActivityIds.remove(activity.id)
    }
  }

  @available(iOS 16.2, *)
  private static func contentState(
    _ payload: [String: Any]
  ) -> OverseerSessionAttributes.ContentState? {
    guard
      let title = payload["title"] as? String,
      let phase = payload["phase"] as? String,
      let updatedAt = date(payload["updatedAt"])
    else { return nil }
    return OverseerSessionAttributes.ContentState(
      title: title,
      activeCount: (payload["activeCount"] as? NSNumber)?.intValue,
      projectName: payload["projectName"] as? String,
      detail: payload["detail"] as? String,
      phase: phase,
      startedAt: date(payload["startedAt"]),
      updatedAt: updatedAt
    )
  }

  private static func date(_ value: Any?) -> Date? {
    guard let milliseconds = (value as? NSNumber)?.doubleValue else { return nil }
    return Date(timeIntervalSince1970: milliseconds / 1000)
  }
}
