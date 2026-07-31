const admin = require("firebase-admin");
const db = admin.firestore();
const { uploadFile } = require("../../services/storage");

/**
 * Send Message
 * POST /chat/message/send
 */
exports.sendMessage = async (req, res) => {
  try {
    const senderUid = req.user.uid;

    let {
      conversationId,
      text,
      type = "text",
      replyTo = null,
    } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID is required.",
      });
    }

    // Validate: a file OR non-empty text must be present
    if (!req.file && type === "text" && (!text || !text.trim())) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty.",
      });
    }

    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationDoc = await conversationRef.get();

    if (!conversationDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    const conversation = conversationDoc.data();

    if (!conversation.members.includes(senderUid)) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this conversation.",
      });
    }

    // Check block status for individual conversations
    if (conversation.type === "individual") {
      const otherUid = conversation.members.find((id) => id !== senderUid);
      const [senderDoc, otherDoc] = await Promise.all([
        db.collection("users").doc(senderUid).get(),
        otherUid ? db.collection("users").doc(otherUid).get() : Promise.resolve(null),
      ]);

      const senderBlocked = senderDoc.data()?.blockedUsers || [];
      const otherBlocked = otherDoc?.data()?.blockedUsers || [];

      if (senderBlocked.includes(otherUid) || otherBlocked.includes(senderUid)) {
        return res.status(403).json({
          success: false,
          message: "You can't send messages to this user.",
        });
      }
    }

    // Handle file upload — file type is already validated by the upload middleware
    let attachment = null;
    if (req.file) {
      const url = await uploadFile(req.file, "chat/attachments");
      const isImage = req.file.mimetype.startsWith("image/");
      type = isImage ? "image" : "document";
      attachment = {
        url,
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      };
    }

    const messageRef = conversationRef.collection("messages").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    const messageData = {
      messageId: messageRef.id,
      conversationId,
      senderId: senderUid,
      type,
      text: type === "text" ? (text || "").trim() : "",
      attachment,
      replyTo,
      edited: false,
      deleted: false,
      seenBy: [senderUid],
      createdAt: now,
      updatedAt: now,
    };

    const lastMessagePreview =
      type === "text"
        ? text.trim()
        : `Sent ${type === "image" ? "an image" : `a ${type}`}`;

    // Build per-member unread increments using dot-notation for atomic field updates
    const unreadIncrements = {};
    conversation.members.forEach((memberUid) => {
      if (memberUid !== senderUid) {
        unreadIncrements[`unreadCount.${memberUid}`] =
          admin.firestore.FieldValue.increment(1);
      }
    });

    await db.runTransaction(async (transaction) => {
      transaction.set(messageRef, messageData);
      transaction.update(conversationRef, {
        lastMessage: lastMessagePreview,
        lastMessageType: type,
        lastMessageSender: senderUid,
        lastMessageTime: now,
        updatedAt: now,
        ...unreadIncrements,
      });
    });

    return res.status(201).json({
      success: true,
      message: "Message sent successfully.",
      data: messageData,
    });
  } catch (error) {
    console.error("Send Message Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Mark Conversation As Seen
 * PATCH /chat/message/seen/:conversationId
 */
exports.markConversationAsSeen = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID is required.",
      });
    }

    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationDoc = await conversationRef.get();

    if (!conversationDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    const conversation = conversationDoc.data();

    if (!conversation.members.includes(uid)) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    // Limit to recent unread messages to keep reads bounded
    const messagesSnapshot = await conversationRef
      .collection("messages")
      .where("senderId", "!=", uid)
      .orderBy("senderId")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const batch = db.batch();

    messagesSnapshot.docs.forEach((doc) => {
      const seenBy = doc.data().seenBy || [];

      if (!seenBy.includes(uid)) {
        batch.update(doc.ref, {
          seenBy: admin.firestore.FieldValue.arrayUnion(uid),
        });
      }
    });

    // Atomically reset the unread count for this user
    batch.update(conversationRef, {
      [`unreadCount.${uid}`]: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      message: "Conversation marked as seen.",
    });
  } catch (error) {
    console.error("Seen Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Edit Message
 * PATCH /chat/message/edit/:messageId
 */
exports.editMessage = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { messageId } = req.params;
    const { conversationId, text } = req.body;

    if (!conversationId || !messageId) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID and Message ID are required.",
      });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty.",
      });
    }

    const messageRef = db
      .collection("conversations")
      .doc(conversationId)
      .collection("messages")
      .doc(messageId);

    const messageDoc = await messageRef.get();

    if (!messageDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Message not found.",
      });
    }

    const message = messageDoc.data();

    if (message.deleted) {
      return res.status(400).json({
        success: false,
        message: "Cannot edit a deleted message.",
      });
    }

    if (message.type !== "text") {
      return res.status(400).json({
        success: false,
        message: "Only text messages can be edited.",
      });
    }

    if (message.senderId !== uid) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your own messages.",
      });
    }

    await messageRef.update({
      text: text.trim(),
      edited: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      message: "Message updated successfully.",
    });
  } catch (error) {
    console.error("Edit Message Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Delete Message (soft delete)
 * DELETE /chat/message/delete/:messageId
 */
exports.deleteMessage = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { messageId } = req.params;
    const { conversationId } = req.body;

    if (!conversationId || !messageId) {
      return res.status(400).json({
        success: false,
        message: "Conversation ID and Message ID are required.",
      });
    }

    const conversationRef = db.collection("conversations").doc(conversationId);
    const conversationDoc = await conversationRef.get();

    if (!conversationDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    if (!conversationDoc.data().members.includes(uid)) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this conversation.",
      });
    }

    const messageRef = conversationRef.collection("messages").doc(messageId);
    const messageDoc = await messageRef.get();

    if (!messageDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Message not found.",
      });
    }

    const message = messageDoc.data();

    if (message.senderId !== uid) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages.",
      });
    }

    if (message.deleted) {
      return res.status(400).json({
        success: false,
        message: "Message already deleted.",
      });
    }

    const conversation = conversationDoc.data();
    const isLastMessage =
      conversation.lastMessageSender === uid &&
      conversation.lastMessage === message.text;

    const batch = db.batch();

    batch.update(messageRef, {
      deleted: true,
      text: "",
      attachment: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const conversationUpdate = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Clear the conversation preview if the deleted message was the last one shown
    if (isLastMessage) {
      conversationUpdate.lastMessage = "Message deleted";
      conversationUpdate.lastMessageType = "system";
    }

    batch.update(conversationRef, conversationUpdate);
    await batch.commit();

    return res.status(200).json({
      success: true,
      message: "Message deleted successfully.",
    });
  } catch (error) {
    console.error("Delete Message Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
