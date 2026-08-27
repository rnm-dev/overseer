export declare const REVERSE_COMMAND_CAPABILITY: "reverse-command-v1";
export declare const REVERSE_COMMAND_MAX_FRAME_BYTES: 61440;
export declare const REVERSE_COMMAND_OPERATIONS: readonly [];
export type ReverseCommandOperation = typeof REVERSE_COMMAND_OPERATIONS[number];
export type ReverseCommandResultStatus = "applied" | "noop" | "rejected" | "conflict" | "cancelled" | "failed";
export type ReverseCommandAcceptedState = "accepted" | "running";
export type ReverseCommandStatusState = "unknown" | "accepted" | "running" | "terminal";
export type DurableMessagePriority = "critical" | "control" | "normal" | "bulk";
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export interface ReverseCommandActor {
    userId: string;
    email: string;
}
export interface ReverseCommandTarget {
    peonId: string;
    sessionId?: string;
    projectId?: string;
    transferId?: string;
}
export interface ReverseCommandEnvelope {
    type: "command";
    protocol: 1;
    capability: typeof REVERSE_COMMAND_CAPABILITY;
    commandId: string;
    operation: ReverseCommandOperation;
    target: ReverseCommandTarget;
    actor: ReverseCommandActor;
    payload: JsonObject;
    expected?: JsonObject | null;
    requestedAt: number;
}
export interface ReverseCommandAcceptedFrame {
    type: "command_accepted";
    protocol: 1;
    commandId: string;
    operation: ReverseCommandOperation;
    state: ReverseCommandAcceptedState;
    replayed: boolean;
    acceptedAt: number;
}
export interface ReverseCommandResultFrame {
    type: "command_result";
    protocol: 1;
    commandId: string;
    operation: ReverseCommandOperation;
    status: ReverseCommandResultStatus;
    code: string;
    message?: string;
    completedAt: number;
    result: JsonObject | null;
}
export interface ReverseCommandStatusFrame {
    type: "command_status";
    protocol: 1;
    commandId: string;
    state: ReverseCommandStatusState;
    result?: ReverseCommandResultFrame;
}
export interface DurableReverseCommandResult {
    type: "durable_message";
    epoch: string;
    cursor: string;
    messageId: string;
    priority: DurableMessagePriority;
    capability: typeof REVERSE_COMMAND_CAPABILITY;
    payload: ReverseCommandResultFrame;
}
