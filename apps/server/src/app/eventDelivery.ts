import { configureCommittedEventConsumers, type CommittedEventConsumer } from "../infrastructure/events/index.js";
import { syncLiveActivitiesForEvent } from "../liveActivity.js";
import { enqueuePushForEvent } from "../push.js";

// Application composition owns the choice of side effects following a durable
// event. The log itself only persists and broadcasts; it must not know about
// notification delivery implementations.
const consumers: readonly CommittedEventConsumer[] = [
  enqueuePushForEvent,
  async (event) => {
    await syncLiveActivitiesForEvent(event).catch((error) => {
      console.warn("live activity: refresh failed:", error instanceof Error ? error.message : String(error));
    });
  },
];

export function configureEventDelivery(): void {
  configureCommittedEventConsumers(consumers);
}
