import ActivityKit
import SwiftUI
import WidgetKit

@available(iOSApplicationExtension 16.2, *)
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

@main
struct OverseerSessionActivityBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOSApplicationExtension 16.2, *) {
      OverseerSessionActivityWidget()
    }
  }
}

@available(iOSApplicationExtension 16.2, *)
struct OverseerSessionActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: OverseerSessionAttributes.self) { context in
      lockScreenView(context)
        .activityBackgroundTint(canvas)
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          signalMark(context.state, size: 34)
        }
        DynamicIslandExpandedRegion(.trailing) {
          activityClock(context.state)
            .font(.caption.weight(.medium).monospacedDigit())
            .foregroundStyle(.white.opacity(0.72))
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(spacing: 2) {
            Text(eyebrow(context.state))
              .font(.caption2.weight(.bold))
              .tracking(1.1)
              .foregroundStyle(accent)
            Text(context.state.title)
              .font(.headline)
              .lineLimit(1)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 9) {
            Text(context.state.detail ?? "Agent signal is active")
              .font(.caption)
              .foregroundStyle(.white.opacity(0.76))
              .lineLimit(2)
            signalFooter(context.state)
          }
        }
      } compactLeading: {
        signalMark(context.state, size: 23)
      } compactTrailing: {
        activityClock(context.state)
          .font(.caption2.weight(.semibold).monospacedDigit())
          .foregroundStyle(accent)
      } minimal: {
        signalMark(context.state, size: 22)
      }
      .widgetURL(deepLink(context.attributes))
      .keylineTint(accent)
    }
  }

  private func lockScreenView(
    _ context: ActivityViewContext<OverseerSessionAttributes>
  ) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 11) {
        signalMark(context.state, size: 36)
        VStack(alignment: .leading, spacing: 3) {
          Text("OVERSEER · LIVE SIGNAL")
            .font(.caption2.weight(.bold))
            .tracking(1.25)
            .foregroundStyle(accent)
          if let projectName = context.state.projectName {
            Text(projectName.uppercased())
              .font(.caption2.weight(.medium))
              .foregroundStyle(.white.opacity(0.48))
              .lineLimit(1)
          }
        }
        Spacer()
        stateBadge(context.state)
      }
      VStack(alignment: .leading, spacing: 5) {
        Text(context.state.title)
          .font(.system(size: 18, weight: .semibold, design: .rounded))
          .foregroundStyle(.white)
          .lineLimit(1)
        Text(context.state.detail ?? "Agent signal is active")
          .font(.subheadline)
          .foregroundStyle(.white.opacity(0.68))
          .lineLimit(2)
      }
      Rectangle()
        .fill(
          LinearGradient(
            colors: [
              stateColor(context.state).opacity(0.05),
              stateColor(context.state),
              signalBlue,
              signalBlue.opacity(0.05),
            ],
            startPoint: .leading,
            endPoint: .trailing
          )
        )
        .frame(height: 1)
      signalFooter(context.state)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .widgetURL(deepLink(context.attributes))
  }

  private func signalFooter(
    _ state: OverseerSessionAttributes.ContentState
  ) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "waveform.path.ecg")
        .font(.caption2.weight(.bold))
        .foregroundStyle(stateColor(state))
      Text(isTerminal(state) ? "FINISHED" : "SIGNAL")
        .font(.caption2.weight(.bold))
        .tracking(0.8)
        .foregroundStyle(.white.opacity(0.45))
      Text(state.updatedAt, style: .relative)
        .font(.caption.monospacedDigit())
        .foregroundStyle(.white.opacity(0.72))
      Spacer()
      Image(systemName: "clock")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(signalBlue)
      activityClock(state)
        .font(.caption.weight(.medium).monospacedDigit())
        .foregroundStyle(.white.opacity(0.78))
    }
  }

  private func signalMark(
    _ state: OverseerSessionAttributes.ContentState,
    size: CGFloat
  ) -> some View {
    ZStack {
      Circle()
        .fill(
          LinearGradient(
            colors: [stateColor(state).opacity(0.28), signalBlue.opacity(0.16)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      Circle()
        .stroke(stateColor(state).opacity(0.42), lineWidth: 1)
      if #available(iOSApplicationExtension 17.0, *) {
        if isTerminal(state) {
          Image(systemName: stateIcon(state))
            .font(.system(size: size * 0.44, weight: .bold))
            .foregroundStyle(stateColor(state))
        } else {
          Image(systemName: stateIcon(state))
            .font(.system(size: size * 0.44, weight: .bold))
            .foregroundStyle(stateColor(state))
            .symbolEffect(.pulse)
        }
      } else {
        Image(systemName: stateIcon(state))
          .font(.system(size: size * 0.44, weight: .bold))
          .foregroundStyle(stateColor(state))
      }
    }
    .frame(width: size, height: size)
  }

  private func stateBadge(_ state: OverseerSessionAttributes.ContentState) -> some View {
    let count = state.activeCount ?? 1
    return HStack(spacing: 5) {
      Circle()
        .fill(stateColor(state))
        .frame(width: 6, height: 6)
      Text(isTerminal(state) ? terminalLabel(state) : count > 1 ? "\(count) ACTIVE" : "LIVE")
        .font(.caption2.weight(.bold))
        .tracking(0.7)
        .foregroundStyle(.white.opacity(0.82))
    }
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(.white.opacity(0.07), in: Capsule())
  }

  private var accent: Color {
    Color(red: 0.32, green: 0.94, blue: 0.69)
  }

  private var signalBlue: Color {
    Color(red: 0.32, green: 0.72, blue: 1.0)
  }

  private var canvas: Color {
    Color(red: 0.035, green: 0.047, blue: 0.073)
  }

  @ViewBuilder
  private func activityClock(_ state: OverseerSessionAttributes.ContentState) -> some View {
    if isTerminal(state) {
      Text(terminalLabel(state))
    } else if let startedAt = state.startedAt {
      Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
    } else {
      Text("LIVE")
    }
  }

  private func isTerminal(_ state: OverseerSessionAttributes.ContentState) -> Bool {
    ["succeeded", "failed", "ended"].contains(state.phase)
  }

  private func terminalLabel(_ state: OverseerSessionAttributes.ContentState) -> String {
    state.phase == "failed" ? "FAILED" : state.phase == "succeeded" ? "DONE" : "ENDED"
  }

  private func stateIcon(_ state: OverseerSessionAttributes.ContentState) -> String {
    state.phase == "failed"
      ? "xmark"
      : isTerminal(state) ? "checkmark" : state.phase == "needsAttention" ? "person.crop.circle.badge.exclamationmark" : "waveform.path.ecg"
  }

  private func stateColor(_ state: OverseerSessionAttributes.ContentState) -> Color {
    state.phase == "failed"
      ? Color(red: 1.0, green: 0.38, blue: 0.42)
      : state.phase == "needsAttention" ? Color(red: 1.0, green: 0.72, blue: 0.28) : accent
  }

  private func eyebrow(_ state: OverseerSessionAttributes.ContentState) -> String {
    let count = state.activeCount ?? 1
    return isTerminal(state)
      ? terminalLabel(state)
      : count > 1 ? "\(count) ACTIVE · LIVE" : "LIVE SIGNAL"
  }

  private func deepLink(_ attributes: OverseerSessionAttributes) -> URL? {
    var components = URLComponents()
    let bundleIdentifier = Bundle.main.bundleIdentifier ?? ""
    components.scheme = bundleIdentifier.contains(".app.dev.")
      ? "overseer-dev"
      : "overseer"
    components.host = "open"
    components.path = "/session"
    components.queryItems = [
      URLQueryItem(name: "workspaceId", value: attributes.workspaceId),
      URLQueryItem(name: "peonId", value: attributes.peonId),
      URLQueryItem(name: "sessionId", value: attributes.sessionId),
    ]
    return components.url
  }
}
