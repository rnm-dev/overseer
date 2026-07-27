import ActivityKit
import Flutter
import Foundation

@available(iOS 16.2, *)
struct OverseerSessionAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let runningCount: Int?
    let completedCount: Int?
    let oldestStartedAt: Date?
    let updatedAt: Date
    // Optional legacy fields let the app retire activities created by older
    // per-session builds without stranding them on the Lock Screen.
    let title: String?
    let activeCount: Int?
    let projectName: String?
    let detail: String?
    let phase: String?
    let startedAt: Date?
  }

  let activityId: String
  let connectionId: String?
  let workspaceId: String?
  let peonId: String?
  let sessionId: String?
}

final class SessionActivityPlugin {
  private static let channelName = "dev.rnm.overseer/session-activities"
  private static var channel: FlutterMethodChannel?
  private static var observedActivityIds = Set<String>()
  private static var observesActivities = false
  private static var observesPushToStartToken = false

  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: channelName,
      binaryMessenger: registrar.messenger()
    )
    self.channel = channel
    observeActivities()
    observePushToStartToken()
    channel.setMethodCallHandler { call, result in
      if call.method == "getPushToStartToken" {
        guard #available(iOS 17.2, *) else {
          result(nil)
          return
        }
        result(hex(Activity<OverseerSessionAttributes>.pushToStartToken))
        return
      }
      guard call.method == "synchronize" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard #available(iOS 16.2, *), ActivityAuthorizationInfo().areActivitiesEnabled else {
        result(nil)
        return
      }
      let arguments = call.arguments as? [String: Any]
      let connectionId = arguments?["connectionId"] as? String ?? ""
      let activities = arguments?["activities"] as? [[String: Any]] ?? []
      Task { @MainActor in
        do {
          try await synchronize(activities, connectionId: connectionId)
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

  private static func observeActivities() {
    guard #available(iOS 16.2, *), !observesActivities else { return }
    observesActivities = true
    for activity in Activity<OverseerSessionAttributes>.activities {
      observePushToken(activity)
    }
    Task {
      for await activity in Activity<OverseerSessionAttributes>.activityUpdates {
        observePushToken(activity)
      }
    }
  }

  private static func observePushToStartToken() {
    guard #available(iOS 17.2, *), !observesPushToStartToken else { return }
    observesPushToStartToken = true
    Task {
      for await tokenData in Activity<OverseerSessionAttributes>.pushToStartTokenUpdates {
        guard let token = hex(tokenData) else { continue }
        await MainActor.run {
          channel?.invokeMethod(
            "pushToStartTokenChanged",
            arguments: ["token": token]
          )
        }
      }
    }
  }

  @available(iOS 16.2, *)
  @MainActor
  private static func synchronize(
    _ payloads: [[String: Any]],
    connectionId: String
  ) async throws {
    let desired = Dictionary(
      payloads.compactMap { payload -> (String, [String: Any])? in
        guard let activityId = payload["activityId"] as? String else { return nil }
        return (activityId, payload)
      },
      uniquingKeysWith: { _, latest in latest }
    )
    let existing = Dictionary(
      grouping: Activity<OverseerSessionAttributes>.activities,
      by: { $0.attributes.activityId }
    )

    for (activityId, activities) in existing where desired[activityId] == nil {
      for activity in activities
      where activity.attributes.connectionId == connectionId
        || activity.attributes.connectionId == nil {
        let current = activity.content.state
        let finalState = OverseerSessionAttributes.ContentState(
          runningCount: 0,
          completedCount: current.completedCount ?? 0,
          oldestStartedAt: current.oldestStartedAt ?? current.startedAt,
          updatedAt: Date(),
          title: current.title,
          activeCount: current.activeCount,
          projectName: current.projectName,
          detail: "Run ended",
          phase: "ended",
          startedAt: current.startedAt
        )
        await activity.end(
          ActivityContent(state: finalState, staleDate: nil),
          dismissalPolicy: .after(Date().addingTimeInterval(90))
        )
      }
    }

    for (activityId, payload) in desired {
      guard let content = contentState(payload) else { continue }
      let activityContent = ActivityContent(state: content, staleDate: nil)
      let matchingActivities = existing[activityId, default: []].filter {
        $0.attributes.connectionId == connectionId
          || $0.attributes.connectionId == nil
      }
      if let activity = matchingActivities.first {
        await activity.update(activityContent)
        observePushToken(activity)
        for duplicate in matchingActivities.dropFirst() {
          await duplicate.end(
            activityContent,
            dismissalPolicy: .immediate
          )
        }
        continue
      }
      let attributes = OverseerSessionAttributes(
        activityId: activityId,
        connectionId: connectionId,
        workspaceId: nil,
        peonId: nil,
        sessionId: nil
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
        guard let token = hex(tokenData) else { continue }
        guard let connectionId = activity.attributes.connectionId else { continue }
        await MainActor.run {
          channel?.invokeMethod(
            "pushTokenChanged",
            arguments: [
              "activityId": activity.id,
              "connectionId": connectionId,
              "token": token,
            ]
          )
        }
      }
      _ = observedActivityIds.remove(activity.id)
    }
  }

  private static func hex(_ data: Data?) -> String? {
    guard let data, !data.isEmpty else { return nil }
    return data.map { String(format: "%02x", $0) }.joined()
  }

  @available(iOS 16.2, *)
  private static func contentState(
    _ payload: [String: Any]
  ) -> OverseerSessionAttributes.ContentState? {
    guard let updatedAt = date(payload["updatedAt"]) else { return nil }
    return OverseerSessionAttributes.ContentState(
      runningCount: (payload["runningCount"] as? NSNumber)?.intValue,
      completedCount: (payload["completedCount"] as? NSNumber)?.intValue,
      oldestStartedAt: date(payload["oldestStartedAt"]),
      updatedAt: updatedAt,
      title: nil,
      activeCount: nil,
      projectName: nil,
      detail: nil,
      phase: nil,
      startedAt: nil
    )
  }

  private static func date(_ value: Any?) -> Date? {
    guard let milliseconds = (value as? NSNumber)?.doubleValue else { return nil }
    return Date(timeIntervalSince1970: milliseconds / 1000)
  }
}
