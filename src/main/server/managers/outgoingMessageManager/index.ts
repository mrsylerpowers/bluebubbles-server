import { Message } from "@server/databases/imessage/entity/Message";
import { MessagePromise } from "./messagePromise";

export class OutgoingMessageManager {
    promises: MessagePromise[] = [];

    add(promise: MessagePromise) {
        this.promises.push(promise);
    }

    findIndex(message: Message, includeResolved = false): number {
        for (let i = 0; i < this.promises.length; i += 1) {
            if (!includeResolved && this.promises[i].isResolved) continue;
            if (this.promises[i].isSame(message)) {
                return i;
            }
        }

        return -1;
    }

    find(message: Message, includeResolved = false): MessagePromise {
        for (let i = 0; i < this.promises.length; i += 1) {
            if (!includeResolved && this.promises[i].isResolved) continue;
            if (this.promises[i].isSame(message)) {
                return this.promises[i];
            }
        }

        return null;
    }
}
