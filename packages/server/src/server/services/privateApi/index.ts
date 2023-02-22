import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import CompareVersions from "compare-versions";
import cpr from "recursive-copy";
import { parse as ParsePlist } from "plist";
import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { ValidTapback } from "@server/types";
import { clamp, isEmpty, isMinBigSur, isMinMonterey, isNotEmpty } from "@server/helpers/utils";
import { restartMessages } from "@server/api/v1/apple/scripts";
import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { TransactionManager } from "@server/managers/transactionManager";

import * as net from "net";
import { ValidRemoveTapback } from "../../types";
import { MAX_PORT, MIN_PORT } from "./constants";
import { TYPING_INDICATOR } from "@server/events";
import { PAPIMessageUpdateListener } from "@server/databases/imessage/listeners/PAPIMessageUpdateListener";

type BundleStatus = {
    success: boolean;
    message: string;
};

export class BlueBubblesHelperService {
    server: net.Server;

    helper: net.Socket;

    restartCounter: number;

    transactionManager: TransactionManager;

    typingCache: Record<string, Record<string, any>> = {};

    static get port(): number {
        return clamp(MIN_PORT + os.userInfo().uid - 501, MIN_PORT, MAX_PORT);
    }

    constructor() {
        this.restartCounter = 0;
        this.transactionManager = new TransactionManager();
        BlueBubblesHelperService.installBundle();
    }

    static async installBundle(force = false): Promise<BundleStatus> {
        const status: BundleStatus = { success: false, message: "Unknown status" };

        // Make sure the Private API is enabled
        const pApiEnabled = Server().repo.getConfig("enable_private_api") as boolean;
        if (!force && !pApiEnabled) {
            status.message = "Private API feature is not enabled";
            return status;
        }

        // eslint-disable-next-line no-nested-ternary
        const macVer = isMinMonterey ? "macos11" : isMinBigSur ? "macos11" : "macos10";
        const localPath = path.join(FileSystem.resources, "private-api", macVer, "BlueBubblesHelper.bundle");
        const localInfo = path.join(localPath, "Contents/Info.plist");

        // If the local bundle doesn't exist, don't do anything
        if (!fs.existsSync(localPath)) {
            status.message = "Unable to locate embedded bundle";
            return status;
        }

        Server().log("Attempting to install Private API Helper Bundle...", "debug");

        // Write to all paths. For MySIMBL & MacEnhance, as well as their user/library variants
        // Technically, MacEnhance is only for Mojave+, however, users may have older versions installed
        // If we find any of the directories, we should install to them
        const opts = [
            FileSystem.libMacForgePlugins,
            // FileSystem.usrMacForgePlugins,
            FileSystem.libMySimblPlugins
            // FileSystem.usrMySimblPlugins
        ];

        // For each of the paths, write the bundle to them (assuming the paths exist & the bundle is newer)
        let writeCount = 0;
        for (const pluginPath of opts) {
            // If the MacForge/MySIMBL path exists, but the plugin path doesn't, create it.
            if (fs.existsSync(path.dirname(pluginPath)) && !fs.existsSync(pluginPath)) {
                Server().log("Plugins path does not exist, creating it...", "debug");
                try {
                    fs.mkdirSync(pluginPath, { recursive: true });
                } catch (ex: any) {
                    Server().log(`Failed to create Plugins path: ${ex?.message ?? String(ex)}`, "debug");
                }
            }

            if (!fs.existsSync(pluginPath)) continue;

            const remotePath = path.join(pluginPath, "BlueBubblesHelper.bundle");
            const remoteInfo = path.join(remotePath, "Contents/Info.plist");

            try {
                // If the remote bundle doesn't exist, we just need to write it
                if (force || !fs.existsSync(remotePath)) {
                    if (force) {
                        Server().log(`Private API Bundle force install. Writing to ${remotePath}`, "debug");
                    } else {
                        Server().log(`Private API Bundle does not exist. Writing to ${remotePath}`, "debug");
                    }

                    await cpr(localPath, remotePath, { overwrite: true, dot: true });
                } else {
                    // Pull the version for the local bundle
                    let parsed = ParsePlist(fs.readFileSync(localInfo).toString("utf-8"));
                    let metadata = JSON.parse(JSON.stringify(parsed)); // We have to do this to access the vars
                    const localVersion = metadata.CFBundleShortVersionString;

                    // Pull the version for the remote bundle
                    parsed = ParsePlist(fs.readFileSync(remoteInfo).toString("utf-8"));
                    metadata = JSON.parse(JSON.stringify(parsed)); // We have to do this to access the vars
                    const remoteVersion = metadata.CFBundleShortVersionString;

                    // Compare the local version to the remote version and overwrite if newer
                    if (CompareVersions(localVersion, remoteVersion) === 1) {
                        Server().log(`Private API Bundle has an update. Writing to ${remotePath}`, "debug");
                        await cpr(localPath, remotePath, { overwrite: true, dot: true });
                    } else {
                        Server().log(`Private API Bundle does not need to be updated`, "debug");
                    }
                }

                writeCount += 1;
            } catch (ex: any) {
                Server().log(`Failed to write to ${remotePath}: ${ex?.message ?? ex}`);
            }
        }

        // Print a log based on if we wrote the bundle anywhere
        if (writeCount === 0) {
            status.message =
                "Attempted to install helper bundle, but neither MySIMBL nor MacForge (MacEnhance) was found!";
            Server().log(status.message, "warn");
        } else {
            // Restart iMessage to "apply" the changes
            Server().log("Restarting iMessage to apply Helper updates...");
            await FileSystem.executeAppleScript(restartMessages());

            status.success = true;
            status.message = "Successfully installed latest Private API Helper Bundle!";
            Server().log(status.message);
        }

        return status;
    }

    configureServer() {
        this.server = net.createServer((socket: net.Socket) => {
            this.helper = socket;
            this.helper.setDefaultEncoding("utf8");

            this.setupListeners();
            this.helper.on("connect", () => {
                Server().log("Private API Helper connected!");
            });

            this.helper.on("close", () => {
                Server().log("Private API Helper disconnected!", "debug");
                this.helper = null;
            });

            this.helper.on("error", () => {
                Server().log("An error occured in the BlueBubblesHelper connection! Closing...", "error");
                if (this.helper) this.helper.destroy();
            });
        });

        this.server.on("error", err => {
            Server().log("An error occured in the TCP Socket! Restarting", "error");
            Server().log(err.toString(), "error");

            if (this.restartCounter <= 5) {
                this.restartCounter += 1;
                this.start();
            } else {
                Server().log("Max restart count reached for Private API listener...");
            }
        });
    }

    start() {
        // Stop anything going on
        this.stop();

        // Configure & start the listener
        Server().log("Starting Private API Helper...", "debug");
        this.configureServer();

        // we need to get the port to open the server on (to allow multiple users to use the bundle)
        // we'll base this off the users uid (a unique id for each user, starting from 501)
        // we'll subtract 501 to get an id starting at 0, incremented for each user
        // then we add this to the base port to get a unique port for the socket
        Server().log(`Starting Socket server on port ${BlueBubblesHelperService.port}`);
        // Listen and reset the restart counter
        this.server.listen(BlueBubblesHelperService.port, "localhost", 511, () => {
            this.restartCounter = 0;
        });
    }

    stop() {
        Server().log(`Stopping Private API Helper...`);

        try {
            if (this.helper && !this.helper.destroyed) {
                this.helper.destroy();
                this.helper = null;
            }
        } catch (ex: any) {
            Server().log(`Failed to stop Private API Helper! Error: ${ex.toString()}`);
        }

        try {
            if (this.server && this.server.listening) {
                Server().log("Stopping Private API Helper...", "debug");

                this.server.removeAllListeners();
                this.server.close();
                this.server = null;
            }
        } catch (ex: any) {
            Server().log(`Failed to stop Private API Helper! Error: ${ex.toString()}`);
        }
    }

    async startTyping(chatGuid: string) {
        if (!this.helper || !this.server) {
            Server().log("Failed to start typing, BlueBubblesHelper is not running!", "error");
            return;
        }
        if (!chatGuid) {
            Server().log("Failed to start typing, no chatGuid specified!", "error");
            return;
        }

        await this.writeData("start-typing", { chatGuid });
    }

    async stopTyping(chatGuid: string) {
        if (!this.helper || !this.server) {
            Server().log("Failed to stop typing, BlueBubblesHelper is not running!", "error");
            return;
        }
        if (!chatGuid) {
            Server().log("Failed to stop typing, no chatGuid specified!", "error");
            return;
        }

        await this.writeData("stop-typing", { chatGuid });
    }

    async markChatRead(chatGuid: string) {
        if (!this.helper || !this.server) {
            Server().log("Failed to mark chat as read, BlueBubblesHelper is not running!", "error");
            return;
        }
        if (!chatGuid) {
            Server().log("Failed to mark chat as read, no chatGuid specified!", "error");
            return;
        }

        await this.writeData("mark-chat-read", { chatGuid });
    }

    async markChatUnread(chatGuid: string) {
        if (!this.helper || !this.server) {
            Server().log("Failed to mark chat as unread, BlueBubblesHelper is not running!", "error");
            return;
        }
        if (!chatGuid) {
            Server().log("Failed to mark chat as unread, no chatGuid specified!", "error");
            return;
        }

        await this.writeData("mark-chat-unread", { chatGuid });
    }

    async sendReaction(
        chatGuid: string,
        selectedMessageGuid: string,
        reactionType: ValidTapback | ValidRemoveTapback,
        partIndex?: number
    ): Promise<TransactionResult> {
        if (!chatGuid || !selectedMessageGuid || !reactionType) {
            throw new Error("Failed to send reaction. Invalid params!");
        }

        const request = new TransactionPromise(TransactionType.MESSAGE);
        return this.writeData(
            "send-reaction",
            {
                chatGuid,
                selectedMessageGuid,
                reactionType,
                partIndex: partIndex ?? 0
            },
            request
        );
    }

    async createChat(addresses: string[], message: string | null): Promise<TransactionResult> {
        if (isEmpty(addresses)) {
            throw new Error("Failed to send reaction. Invalid params!");
        }

        const request = new TransactionPromise(TransactionType.CHAT);
        return this.writeData("create-chat", { addresses, message }, request);
    }

    async deleteChat(guid: string): Promise<TransactionResult> {
        if (isEmpty(guid)) {
            throw new Error("Failed to delete chat. Invalid params!");
        }

        const request = new TransactionPromise(TransactionType.CHAT);
        return this.writeData("delete-chat", { chatGuid: guid }, request);
    }

    async editMessage({
        chatGuid,
        messageGuid,
        editedMessage,
        backwardsCompatMessage,
        partIndex
    }: {
        chatGuid: string;
        messageGuid: string;
        editedMessage: string;
        backwardsCompatMessage: string;
        partIndex: number;
    }): Promise<TransactionResult> {
        if (isEmpty(chatGuid)) throw new Error("Failed to edit message. Chat GUID not provided!");
        if (isEmpty(messageGuid)) throw new Error("Failed to edit message. Message GUID not provided!");
        if (isEmpty(editedMessage)) throw new Error("Failed to edit message. Edited Message not provided!");
        if (isEmpty(backwardsCompatMessage))
            throw new Error("Failed to edit message. Backwards Compatibility Message not provided!");
        if (partIndex == null) throw new Error("Failed to edit message. Part Index not provided!");

        const request = new TransactionPromise(TransactionType.MESSAGE);
        return this.writeData(
            "edit-message",
            {
                chatGuid,
                messageGuid,
                editedMessage,
                backwardsCompatibilityMessage: backwardsCompatMessage,
                partIndex
            },
            request
        );
    }

    async unsendMessage({
        chatGuid,
        messageGuid,
        partIndex
    }: {
        chatGuid: string;
        messageGuid: string;
        partIndex: number;
    }): Promise<TransactionResult> {
        if (isEmpty(chatGuid)) throw new Error("Failed to edit message. Chat GUID not provided!");
        if (isEmpty(messageGuid)) throw new Error("Failed to edit message. Message GUID not provided!");
        if (partIndex == null) throw new Error("Failed to edit message. Part Index not provided!");

        const request = new TransactionPromise(TransactionType.MESSAGE);
        return this.writeData(
            "unsend-message",
            {
                chatGuid,
                messageGuid,
                partIndex
            },
            request
        );
    }

    async sendMessage(
        chatGuid: string,
        message: string,
        attributedBody: Record<string, any> = null,
        subject: string = null,
        effectId: string = null,
        selectedMessageGuid: string = null,
        partIndex = 0
    ): Promise<TransactionResult> {
        if (!chatGuid || !message) {
            throw new Error("Failed to send message. Invalid params!");
        }

        const request = new TransactionPromise(TransactionType.MESSAGE);
        return this.writeData(
            "send-message",
            {
                chatGuid,
                subject,
                message,
                attributedBody,
                effectId,
                selectedMessageGuid,
                partIndex
            },
            request
        );
    }

    async sendAttachment({
        chatGuid,
        filePath,
        isAudioMessage = false,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0
    }: {
        chatGuid: string;
        filePath: string;
        isAudioMessage?: boolean;
        attributedBody?: Record<string, any> | null;
        subject?: string;
        effectId?: string;
        selectedMessageGuid?: string;
        partIndex?: number;
    }): Promise<TransactionResult> {
        if (!chatGuid || !filePath) {
            throw new Error("Failed to send attachment. Invalid params!");
        }

        const request = new TransactionPromise(TransactionType.ATTACHMENT);
        return this.writeData(
            "send-attachment",
            {
                chatGuid,
                filePath,
                isAudioMessage: isAudioMessage ? 1 : 0,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex
            },
            request
        );
    }

    async addParticipant(chatGuid: string, address: string) {
        return this.toggleParticipant(chatGuid, address, "add");
    }

    async removeParticipant(chatGuid: string, address: string) {
        return this.toggleParticipant(chatGuid, address, "remove");
    }

    async toggleParticipant(chatGuid: string, address: string, action: "add" | "remove"): Promise<TransactionResult> {
        if (!chatGuid || !address || !action) {
            throw new Error(`Failed to ${action} participant to chat. Invalid params!`);
        }

        const request = new TransactionPromise(TransactionType.CHAT);
        return this.writeData(`${action}-participant`, { chatGuid, address }, request);
    }

    async setDisplayName(chatGuid: string, newName: string): Promise<TransactionResult> {
        if (!chatGuid || !newName) {
            throw new Error("Failed to set chat display name. Invalid params!");
        }

        const request = new TransactionPromise(TransactionType.CHAT);
        return this.writeData("set-display-name", { chatGuid, newName }, request);
    }

    async getTypingStatus(chatGuid: string): Promise<TransactionResult> {
        if (!chatGuid) {
            throw new Error("Failed to retreive typing status, no chatGuid specified!");
        }

        return this.writeData("check-typing-status", { chatGuid });
    }

    async handleTypingIndicator(event: string, guid: string) {
        const display = event === "started-typing";
        let shouldEmit = false;

        // If the guid hasn't been seen before, we should emit the event
        const now = new Date().getTime();
        if (!Object.keys(this.typingCache).includes(guid)) {
            shouldEmit = true;
        } else {
            // If the last value was different than the current value, we should emit the event
            if (this.typingCache[guid].lastValue !== display) {
                shouldEmit = true;
            } else {
                // If the value is the same, we should emit the event if it's been more than 5 seconds
                const lastSeen = this.typingCache[guid].lastSeen;
                if (now - lastSeen > 5000) {
                    shouldEmit = true;
                }
            }
        }

        if (shouldEmit) {
            // Update the cache values
            this.typingCache[guid] = {
                lastSeen: now,
                lastValue: display
            };

            Server().emitMessage(TYPING_INDICATOR, { display, guid }, "normal", false);
        }
    }

    setupListeners() {
        this.helper.on("data", (eventRaw: string) => {
            if (eventRaw == null) {
                Server().log(`Received null data from BlueBubblesHelper!`);
                return;
            }

            // Data can contain multiple events, each split by the demiliter (\n)
            const eventData: string[] = String(eventRaw).split("\n");
            const uniqueEvents = [...new Set(eventData)];
            for (const event of uniqueEvents) {
                if (!event || event.trim().length === 0) continue;
                if (event == null) {
                    Server().log(`Failed to decode null BlueBubblesHelper data!`);
                    continue;
                }

                Server().log(`Received data from BlueBubblesHelper: ${event}`, "debug");
                let data;

                // Handle in a timeout so that we handle each event asyncronously
                try {
                    data = JSON.parse(event);
                } catch (e) {
                    Server().log(`Failed to decode BlueBubblesHelper data! ${event}, ${e}`);
                    return;
                }

                if (data == null) {
                    Server().log("BlueBubblesHelper sent null data", "warn");
                    return;
                }

                if (data.transactionId) {
                    // Resolve the promise from the transaction manager
                    const idx = this.transactionManager.findIndex(data.transactionId);
                    if (idx >= 0) {
                        if (isNotEmpty(data?.error ?? "")) {
                            this.transactionManager.promises[idx].reject(data.error);
                        } else {
                            this.transactionManager.promises[idx].resolve(data.identifier, data?.data);
                        }
                    }
                } else if (data.event) {
                    if (data.event === "ping") {
                        Server().log("Private API Helper connected!");
                    } else if (data.event === "started-typing" || data.event === "stopped-typing") {
                        this.handleTypingIndicator(data.event, data.guid);
                    } else if (data.event === "message-update") {
                        Server()
                            .chatListeners.find((listener: any) => listener instanceof PAPIMessageUpdateListener)
                            ?.onReceiveMessageUpdate(data.guid);
                    }
                }
            }
        });
    }

    private async writeData(
        action: string,
        data: NodeJS.Dict<any>,
        transaction?: TransactionPromise
    ): Promise<TransactionResult> {
        const msg = "Failed to send request to Private API!";

        // If we have a transaction, add it to the manager
        if (transaction) {
            this.transactionManager.add(transaction);
        }

        try {
            await new Promise((resolve, reject) => {
                const d: NodeJS.Dict<any> = { action, data };

                // If we have a transaction, set the transaction ID for the request
                if (transaction) {
                    d.transactionId = transaction.transactionId;
                }

                // Write the request to the socket
                const res = this.helper.write(`${JSON.stringify(d)}\n`, (err: Error) => {
                    if (err) {
                        Server().log(`Socket write error: ${err?.message ?? String(err)}`);
                        reject(err);
                    }
                });

                if (!res) {
                    reject(new Error("Unable to write to TCP Socket."));
                } else {
                    resolve(res);
                }
            });

            // If we have a transaction, wait until the transaction is fulfilled to return
            if (transaction) {
                return transaction.promise;
            }
        } catch (ex: any) {
            Server().log(`${msg} ${ex?.message ?? ex}`, "debug");
        }

        return null;
    }
}
