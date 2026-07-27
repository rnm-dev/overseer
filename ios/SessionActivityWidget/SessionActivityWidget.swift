import ActivityKit
import SwiftUI
import WidgetKit

private extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }
}

private enum ActivityPalette {
  static let voidColor = Color(hex: 0x0B0C0B)
  static let iron800 = Color(hex: 0x262A23)
  static let fel = Color(hex: 0x86AB63)
  static let felBright = Color(hex: 0xA6C78A)
  static let felDeep = Color(hex: 0x5C7A41)
  static let forge = Color(hex: 0xD99441)
  static let blood = Color(hex: 0xD95F48)
  static let bone = Color(hex: 0xE7E6DC)
  static let boneDim = Color(hex: 0x9A9C8E)
  static let boneFaint = Color(hex: 0x64685A)
}

@available(iOSApplicationExtension 16.2, *)
struct OverseerSessionAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let runningCount: Int?
    let completedCount: Int?
    let oldestStartedAt: Date?
    let updatedAt: Date
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
        .activityBackgroundTint(ActivityPalette.voidColor)
        .activitySystemActionForegroundColor(ActivityPalette.bone)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          signalMark(size: 34)
        }
        DynamicIslandExpandedRegion(.trailing) {
          runtime(context.state)
            .font(.caption.weight(.medium).monospacedDigit())
            .foregroundStyle(ActivityPalette.boneDim)
        }
        DynamicIslandExpandedRegion(.center) {
          Text("OVERSEER · LIVE")
            .font(.caption2.weight(.bold))
            .tracking(1.1)
            .foregroundStyle(ActivityPalette.felBright)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 8) {
            metric(
              value: runningCount(context.state),
              label: "RUNNING",
              color: ActivityPalette.felBright
            )
            metric(
              value: completedCount(context.state),
              label: "COMPLETED",
              color: ActivityPalette.forge
            )
          }
        }
      } compactLeading: {
        HStack(spacing: 4) {
          Circle()
            .fill(ActivityPalette.felBright)
            .frame(width: 7, height: 7)
          Text("\(runningCount(context.state))")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(ActivityPalette.bone)
        }
      } compactTrailing: {
        runtime(context.state)
          .font(.caption2.weight(.semibold).monospacedDigit())
          .foregroundStyle(ActivityPalette.felBright)
      } minimal: {
        signalMark(size: 22)
      }
      .widgetURL(deepLink())
      .keylineTint(ActivityPalette.fel)
    }
  }

  private func lockScreenView(
    _ context: ActivityViewContext<OverseerSessionAttributes>
  ) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        signalMark(size: 34)
        VStack(alignment: .leading, spacing: 2) {
          Text("OVERSEER · LIVE SIGNAL")
            .font(.caption2.weight(.bold))
            .tracking(1.2)
            .foregroundStyle(ActivityPalette.felBright)
          Text("Agent sessions")
            .font(.caption)
            .foregroundStyle(ActivityPalette.boneDim)
        }
        Spacer()
        runtime(context.state)
          .font(.subheadline.weight(.semibold).monospacedDigit())
          .foregroundStyle(ActivityPalette.bone)
      }

      HStack(spacing: 9) {
        metric(
          value: runningCount(context.state),
          label: "RUNNING",
          color: ActivityPalette.felBright
        )
        metric(
          value: completedCount(context.state),
          label: "COMPLETED",
          color: ActivityPalette.forge
        )
      }

      HStack(spacing: 5) {
        Image(systemName: "waveform.path.ecg")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ActivityPalette.fel)
        Text("UPDATED")
          .font(.caption2.weight(.bold))
          .tracking(0.8)
          .foregroundStyle(ActivityPalette.boneFaint)
        Text(context.state.updatedAt, style: .relative)
          .font(.caption.monospacedDigit())
          .foregroundStyle(ActivityPalette.boneDim)
        Spacer()
        Text("Tap to open")
          .font(.caption2)
          .foregroundStyle(ActivityPalette.boneFaint)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .widgetURL(deepLink())
  }

  private func metric(value: Int, label: String, color: Color) -> some View {
    HStack(spacing: 7) {
      Circle()
        .fill(color)
        .frame(width: 7, height: 7)
      Text("\(value)")
        .font(.headline.weight(.bold).monospacedDigit())
        .foregroundStyle(ActivityPalette.bone)
      Text(label)
        .font(.caption2.weight(.bold))
        .tracking(0.7)
        .foregroundStyle(color)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(ActivityPalette.iron800, in: RoundedRectangle(cornerRadius: 10))
  }

  private func signalMark(size: CGFloat) -> some View {
    ZStack {
      Circle()
        .fill(ActivityPalette.fel.opacity(0.2))
      Circle()
        .stroke(ActivityPalette.fel.opacity(0.45), lineWidth: 1)
      Image(systemName: "waveform.path.ecg")
        .font(.system(size: size * 0.42, weight: .bold))
        .foregroundStyle(ActivityPalette.felBright)
    }
    .frame(width: size, height: size)
  }

  @ViewBuilder
  private func runtime(_ state: OverseerSessionAttributes.ContentState) -> some View {
    if runningCount(state) == 0 {
      Text("DONE")
    } else if let startedAt = state.oldestStartedAt ?? state.startedAt {
      Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
    } else {
      Text("LIVE")
    }
  }

  private func runningCount(_ state: OverseerSessionAttributes.ContentState) -> Int {
    max(0, state.runningCount ?? state.activeCount ?? 0)
  }

  private func completedCount(_ state: OverseerSessionAttributes.ContentState) -> Int {
    max(0, state.completedCount ?? 0)
  }

  private func deepLink() -> URL? {
    let bundleIdentifier = Bundle.main.bundleIdentifier ?? ""
    let scheme = bundleIdentifier.contains(".app.dev.") ? "overseer-dev" : "overseer"
    return URL(string: "\(scheme)://open")
  }
}
