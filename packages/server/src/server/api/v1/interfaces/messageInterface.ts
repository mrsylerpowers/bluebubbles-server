import { Server } from "@server";
import * as fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { MessagePromise } from "@server/managers/outgoingMessageManager/messagePromise";
import { Message } from "@server/databases/imessage/entity/Message";
import { checkPrivateApiStatus, isMinMonterey, isNotEmpty, resultAwaiter } from "@server/helpers/utils";
import { negativeReactionTextMap, reactionTextMap } from "@server/api/v1/apple/mappings";
import { invisibleMediaChar } from "@server/services/httpService/constants";
import { ActionHandler } from "@server/api/v1/apple/actions";
import type {
    SendMessageParams,
    SendAttachmentParams,
    SendMessagePrivateApiParams,
    SendReactionParams,
    UnsendMessageParams,
    EditMessageParams
} from "@server/api/v1/types";
import {SendAttachmentPrivateApiParams} from "@server/api/v1/types";

export class MessageInterface {
    static possibleReactions: string[] = [
        "love",
        "like",
        "dislike",
        "laugh",
        "emphasize",
        "question",
        "-love",
        "-like",
        "-dislike",
        "-laugh",
        "-emphasize",
        "-question"
    ];

    /**
     * Sends a message by executing the sendMessage AppleScript
     *
     * @param chatGuid The GUID for the chat
     * @param message The message to send
     * @param attachmentName The name of the attachment to send (optional)
     * @param attachment The bytes (buffer) for the attachment
     *
     * @returns The command line response
     */
    static async sendMessageSync({
        chatGuid,
        message,
        method = "apple-script",
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        fileTransferGUIDs = null,
        tempGuid = null,
        partIndex = 0
    }: SendMessageParams): Promise<Message> {
        if (!chatGuid) throw new Error("No chat GUID provided");

        Server().log(`Sending message "${message}" to ${chatGuid}`, "debug");
        Server().log( ` ${chatGuid},
            ${message}
            ${method},
            ${attributedBody} ,
            ${subject} ,
            ${effectId} ,
            ${selectedMessageGuid} ,
            ${fileTransferGUIDs} ,
            ${tempGuid} ,
            ${partIndex} `, "debug");

        // We need offsets here due to iMessage's save times being a bit off for some reason
        const now = new Date(new Date().getTime() - 10000).getTime(); // With 10 second offset
        const awaiter = new MessagePromise({
            chatGuid,
            text: message,
            isAttachment: fileTransferGUIDs !== null,
            sentAt: now,
            subject,
            tempGuid
        });

        // Add the promise to the manager
        Server().log(`Adding await for chat: "${chatGuid}"; text: ${awaiter.text}; tempGuid: ${tempGuid ?? "N/A"}`);
        Server().messageManager.add(awaiter);

        // Try to send the iMessage
        let sentMessage = null;
        if (method === "apple-script") {
            // Attempt to send the message
            await ActionHandler.sendMessageHandler(chatGuid, message ?? "", null);
            sentMessage = await awaiter.promise;
        } else if (method === "private-api") {
            sentMessage = await MessageInterface.sendMessagePrivateApi({
                chatGuid,
                message,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                fileTransferGUIDs,
                partIndex
            });
        } else {
            throw new Error(`Invalid send method: ${method}`);
        }

        return sentMessage;
    }

    /**
     * Sends a message by executing the sendMessage AppleScript
     *
     * @param chatGuid The GUID for the chat
     * @param message The message to send
     * @param attachmentName The name of the attachment to send (optional)
     * @param attachment The bytes (buffer) for the attachment
     *
     * @returns The command line response
     */
    static async sendAttachmentSync({
        chatGuid,
        attachmentPath,
        attachmentName = null,
        attachmentGuid = null,
        method = 'apple-script',
        effectId = null,
    }: SendAttachmentParams): Promise<Message> {
        if (!chatGuid) throw new Error("No chat GUID provided");

        // Copy the attachment to a more permanent storage
        const newPath = FileSystem.copyAttachment(attachmentPath, attachmentName);

        Server().log(`Sending attachment "${attachmentName}" to ${chatGuid}`, "debug");
        Server().log( ` ${chatGuid},
            ${attachmentPath}
            ${method},
            ${newPath} ,
    
            ${effectId} ,
           `, "debug");
        // Make sure messages is open
        await FileSystem.startMessages();

        // Since we convert mp3s to cafs we need to correct the name for the awaiter
        let aName = attachmentName;
        if (aName !== null && aName.endsWith(".mp3")) {
            aName = `${aName.substring(0, aName.length - 4)}.caf`;
        }

        // We need offsets here due to iMessage's save times being a bit off for some reason
        const now = new Date(new Date().getTime() - 10000).getTime(); // With 10 second offset
        const awaiter = new MessagePromise({
            chatGuid: chatGuid,
            text: aName,
            isAttachment: true,
            sentAt: now,
            tempGuid: attachmentGuid
        });

        // Add the promise to the manager
        Server().log(
            `Adding await for chat: "${chatGuid}"; attachment: ${aName}; tempGuid: ${attachmentGuid ?? "N/A"}`
        );
        Server().messageManager.add(awaiter);
        let ret = null;
        if (method === "apple-script") {
            // Send the message
            await ActionHandler.sendMessageHandler(chatGuid, "", newPath);
             ret = await awaiter.promise;
        } else if (method === "private-api") {
            ret = await MessageInterface.sendAttachmentPrivateApi({
                chatGuid,
                filePath: newPath,
                effectId,
            });
        }


        // Delete the attachment.
        // Only if below Monterey. On Monterey, we store attachments
        // within the iMessage App Support directory. When AppleScript sees this
        // it _does not_ copy the attachment to a permanent location.
        // This means that if we delete the attachment, it won't be downloadable anymore.
        if (!isMinMonterey) {
            fs.unlink(newPath, _ => null);
        }

        return ret;
    }

    static async sendMessagePrivateApi({
        chatGuid,
        message,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        fileTransferGUIDs,
        partIndex = 0
    }: SendMessagePrivateApiParams) {
        checkPrivateApiStatus();
        const result = await Server().privateApiHelper.sendMessage(
            chatGuid,
            message,
            attributedBody ?? null,
            subject ?? null,
            effectId ?? null,
            selectedMessageGuid ?? null,
            fileTransferGUIDs,
            partIndex ?? 0
        );

        if (!result?.identifier) {
            throw new Error("Failed to send message!");
        }

        const maxWaitMs = 30000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(result.identifier, true, false);
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(`Failed to send message! Message not found in database after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }

    static async sendAttachmentPrivateApi({
        chatGuid,
        effectId = null,
        filePath,
    }: SendAttachmentPrivateApiParams) {
        checkPrivateApiStatus();
        const result = await Server().privateApiHelper.sendAttachment(filePath,effectId, chatGuid);

        if (!result?.identifier) {
            throw new Error("Failed to send message!");
        }

        const maxWaitMs = 30000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(result.identifier, true, true);
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(`Failed to send message! Message not found in database after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }
    static async unsendMessage({ chatGuid, messageGuid, partIndex = 0 }: UnsendMessageParams) {
        checkPrivateApiStatus();
        const msg = await Server().iMessageRepo.getMessage(messageGuid, false, false);
        const currentEditDate = msg?.dateEdited ?? 0;
        await Server().privateApiHelper.unsendMessage({ chatGuid, messageGuid, partIndex: partIndex ?? 0 });

        const maxWaitMs = 30000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(messageGuid, true, false);
            },
            extraLoopCondition: data => {
                if (!data) return false;
                return (data?.dateEdited ?? 0) > currentEditDate;
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(`Failed to unsend message! Message not edited (unsent) after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }

    static async editMessage({
        chatGuid,
        messageGuid,
        editedMessage,
        backwardsCompatMessage,
        partIndex = 0
    }: EditMessageParams) {
        checkPrivateApiStatus();
        const msg = await Server().iMessageRepo.getMessage(messageGuid, false, false);
        const currentEditDate = msg?.dateEdited ?? 0;
        await Server().privateApiHelper.editMessage({
            chatGuid,
            messageGuid,
            editedMessage,
            backwardsCompatMessage,
            partIndex: partIndex ?? 0
        });

        const maxWaitMs = 30000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(messageGuid, true, false);
            },
            extraLoopCondition: data => {
                if (!data) return false;
                return (data?.dateEdited ?? 0) > currentEditDate;
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(`Failed to edit message! Message not edited after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }

    static async sendReaction({
        chatGuid,
        message,
        reaction,
        tempGuid = null,
        partIndex = 0
    }: SendReactionParams): Promise<Message> {
        checkPrivateApiStatus();

        // Rebuild the selected message text to make it what the reaction text
        // would be in the database
        const prefix = (reaction as string).startsWith("-")
            ? negativeReactionTextMap[reaction as string]
            : reactionTextMap[reaction as string];

        // If the message text is just the invisible char, we know it's probably just an attachment
        const text = message.universalText(false) ?? "";
        const isOnlyMedia = text.length === 1 && text === invisibleMediaChar;

        // Default the message to the other message surrounded by greek quotes
        let msg = `“${text}”`;

        let matchingGuid: string = null;
        for (const i of message?.attributedBody ?? []) {
            for (const run of i?.runs ?? []) {
                if (run?.attributes?.__kIMMessagePartAttributeName === partIndex) {
                    matchingGuid = run?.attributes?.__kIMFileTransferGUIDAttributeName;
                    if (matchingGuid) break;
                }
            }

            if (matchingGuid) break;
        }

        // If we have a matching guid, we know it's an attachment. Pull it out
        let attachment = (message?.attachments ?? []).find(a => a.guid === matchingGuid);

        // If we don't have a match, but we know it's media only, select the first attachment
        if (!attachment && isOnlyMedia && isNotEmpty(message.attachments)) {
            attachment = message?.attachments[0];
        }

        // If we have an attachment, build the message based on the mime type
        if (attachment) {
            const mime = attachment.mimeType ?? "";
            const uti = attachment.uti ?? "";
            if (mime.startsWith("image")) {
                msg = `an image`;
            } else if (mime.startsWith("video")) {
                msg = `a movie`;
            } else if (mime.startsWith("audio") || uti.includes("coreaudio-format")) {
                msg = `an audio message`;
            } else {
                msg = `an attachment`;
            }
        } else {
            // If there is no attachment, use the message text
            msg = msg.replace(invisibleMediaChar, "");
        }

        // Build the final message to match on
        const messageText = `${prefix} ${msg}`;

        // We need offsets here due to iMessage's save times being a bit off for some reason
        const now = new Date(new Date().getTime() - 10000).getTime(); // With 10 second offset
        const awaiter = new MessagePromise({ chatGuid, text: messageText, isAttachment: false, sentAt: now, tempGuid });
        Server().messageManager.add(awaiter);

        // Send the reaction
        const result = await Server().privateApiHelper.sendReaction(chatGuid, message.guid, reaction, partIndex ?? 0);
        if (!result?.identifier) {
            throw new Error("Failed to send reaction! No message GUID returned.");
        } else {
            Server().log(`Reaction sent with Message GUID: ${result.identifier}`, "debug");
        }

        const maxWaitMs = 30000;
        let retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(result.identifier, true, false);
            }
        });

        // If we can't get the message via the transaction, try via the promise
        if (!retMessage) {
            retMessage = await awaiter.promise;
        }

        // Check if the name changed
        if (!retMessage) {
            throw new Error(
                `Failed to send reaction! Message not found in database after ${maxWaitMs / 1000} seconds!`
            );
        }

        // Return the message
        return retMessage;
    }
}
