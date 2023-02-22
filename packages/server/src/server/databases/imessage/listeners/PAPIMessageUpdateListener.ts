import { EventEmitter } from "events";
import { EventCache } from "@server/eventCache";
import { Message } from "@server/databases/imessage/entity/Message";
import { Server } from "@server";
import { MessageRepository } from "@server/databases/imessage";
import { isNotEmpty } from "@server/helpers/utils";

type MessageState = {
    dateCreated: number;
    dateDelivered: number;
    dateRead: number;
    dateEdited: number;
    dateRetracted: number;
};

export class PAPIMessageUpdateListener extends EventEmitter {
    // Cache of messages that have been "seen" by a listener
    cache: EventCache;

    // Cache of the last state of the message that has been seen by a listener
    cacheState: Record<string, MessageState>;

    lastCheck: Date;

    stopped: boolean;

    repo: MessageRepository;
    private notSent: string[];

    constructor(cache = new EventCache(), repo: MessageRepository) {
        super();

        this.cache = cache;
        this.cacheState = {};
        this.stopped = false;
        this.lastCheck = new Date();
        this.repo = repo;
    }

    stop() {
        this.stopped = true;
        this.removeAllListeners();
    }

    checkCache() {
        // Purge emitted messages if it gets above 250 items
        // 250 is pretty arbitrary at this point...
        if (this.cache.size() > 250) {
            if (this.cache.size() > 0) {
                this.cache.purge();
            }
        }

        // Purge anything from the cache where the date created is > 5 minutes old
        const now = new Date().getTime();
        const fiveMinutesAgo = now - 5 * 60 * 1000;
        for (const key in this.cacheState) {
            if (this.cacheState[key].dateCreated < fiveMinutesAgo) {
                delete this.cacheState[key];
            }
        }
    }

    getMessageEvent(message: Message): string | null {
        // If the GUID doesn't exist, it's a new message
        const guid = message.guid;
        if (!this.cache.find(guid)) return "new-entry";

        // If the GUID exists, check the date created.
        // If it doesn't exist, a race condition occurred and we should ignore it (return null)
        const state = this.cacheState[guid];
        if (!state) return null;

        // If any of the dates are newer, it's an update
        if (message.dateCreated.getTime() > state.dateCreated) return "updated-entry";

        const delivered = message?.dateDelivered ? message.dateDelivered.getTime() : 0;
        if (delivered > state.dateDelivered) return "updated-entry";

        const read = message?.dateRead ? message.dateRead.getTime() : 0;
        if (read > state.dateRead) return "updated-entry";

        const edited = message?.dateEdited ? message.dateEdited.getTime() : 0;
        if (edited > state.dateEdited) return "updated-entry";

        const retracted = message?.dateRetracted ? message.dateRetracted.getTime() : 0;
        if (retracted > state.dateRetracted) return "updated-entry";

        return null;
    }

    processMessageEvent(message: Message): string | null {
        const event = this.getMessageEvent(message);
        if (!event) return null;

        if (event === "new-entry") {
            this.cache.add(message.guid);
        }

        this.cacheState[message.guid] = {
            dateCreated: message.dateCreated.getTime(),
            dateDelivered: message?.dateDelivered ? message.dateDelivered.getTime() : 0,
            dateRead: message?.dateRead ? message.dateRead.getTime() : 0,
            dateEdited: message.dateEdited ? message.dateEdited.getTime() : 0,
            dateRetracted: message.dateRetracted ? message.dateRetracted.getTime() : 0
        };

        return event;
    }

    start() {
        this.cache.purge();
        this.lastCheck = new Date();
    }
    // eslint-disable-next-line class-methods-use-this
    transformEntry(entry: Message) {
        return entry;
    }

    async onReceiveMessageUpdate(messageGUID: string, isSent: boolean, isFromMe: boolean): Promise<void> {
        Server().log("MESSAGE UPDATE OBJECT RECEIVED");
        Server().log(messageGUID);

        if (isFromMe) {
            await this.handleOutgoingMessage(messageGUID, isFromMe, isSent);
            return this.handleOutgoingMessageUpdate(messageGUID, isFromMe, isSent);
        } else {
            const newMessage = await this.repo.getMessage(messageGUID, true);
            const event = this.processMessageEvent(newMessage);
            if (!event) return;

            // Emit the event
            super.emit(event, "incoming-message", this.transformEntry(newMessage));
        }
    }

    private async handleOutgoingMessage(messageGUID: string, isFromMe: boolean, isSent: boolean) {
        const newMessage = await this.repo.getMessage(messageGUID, true);
        const newSent = isSent ? newMessage : null;
        const newUnsent = !isSent ? newMessage : null;

        if (newUnsent) {
            Server().log(`Detected ${newUnsent.guid} unsent outgoing message(s)`, "debug");
        }
        let unsentIds: string = newUnsent.guid;
        for (const i of this.notSent) {
            if (unsentIds !== i) unsentIds = i;
        }
        let lookbackMessage: Message;
        if (isNotEmpty(unsentIds)) {
            lookbackMessage = await this.repo.getMessage(unsentIds, true);
        }
        if (isNotEmpty(lookbackMessage)) {
            Server().log(`Detected ${lookbackMessage.guid} sent (previously unsent) message(s)`, "debug");
        }

        const lookbackSent = lookbackMessage.isSent && (lookbackMessage?.error ?? 0) === 0 ? lookbackMessage : null;
        const lookbackErrored = (lookbackMessage?.error ?? 0) > 0 ? lookbackMessage : null;
        const lookbackUnsent = !lookbackMessage.isSent && (lookbackMessage?.error ?? 0) === 0 ? lookbackMessage : null;

        this.notSent = [lookbackUnsent.guid];

        const toEmit = [];
        if (newSent) toEmit.push(newSent);
        if (lookbackSent) toEmit.push(lookbackSent);

        for (const entry of toEmit) {
            const event = this.processMessageEvent(entry);
            if (!event) return;

            // Resolve the promise for sent messages from a client
            Server().messageManager.resolve(entry);

            // Emit it as normal entry
            super.emit(event, "outgoing-message", entry);
        }
        for (const entry of [lookbackErrored]) {
            const event = this.processMessageEvent(entry);
            if (!event) return;

            // Reject the corresponding promise.
            // This will emit a message send error
            const success = await Server().messageManager.reject("message-send-error", entry);
            Server().log(
                `Errored Msg -> ${entry.guid} -> ${entry.contentString()} -> ${success} (Code: ${entry.error})`,
                "debug"
            );

            // Emit it as normal error
            if (!success) {
                Server().log(
                    `Message Manager Match Failed -> Promises: ${Server().messageManager.promises.length}`,
                    "debug"
                );
                super.emit("message-send-error", "outgoing-message", entry);
            }
        }
    }

    private async handleOutgoingMessageUpdate(messageGUID: string, isFromMe: boolean, isSent: boolean) {
        const entry = await this.repo.getMessage(messageGUID, true);
        const event = this.processMessageEvent(entry);
        if (!event) return;

        // Resolve the promise
        Server().messageManager.resolve(entry);

        // Emit it as a normal update
        super.emit(event, entry);
    }
}
