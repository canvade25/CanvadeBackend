const admin = require("firebase-admin");
const db = admin.firestore();

/**
 * Send Group Message
 * POST /chat/group/message/send
 */
exports.sendGroupMessage = async (req, res) => {
  try {
    const senderUid = req.user.uid;

    const {
      groupId,
      text,
      type = "text",
      attachment = null,
      replyTo = null,
    } = req.body;

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: "Group ID is required.",
      });
    }

    if (type === "text" && (!text || !text.trim())) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty.",
      });
    }

    if (type !== "text" && !attachment) {
      return res.status(400).json({
        success: false,
        message: "Attachment is required for non-text messages.",
      });
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Group not found.",
      });
    }

    const group = groupDoc.data();

    if (!group.isActive) {
      return res.status(400).json({
        success: false,
        message: "Group is inactive.",
      });
    }

    const memberDoc = await groupRef.collection("members").doc(senderUid).get();

    if (!memberDoc.exists) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this group.",
      });
    }

    // Fetch all members once to build per-member unread increments
    const membersSnapshot = await groupRef.collection("members").get();

    const messageRef = groupRef.collection("messages").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    const messageData = {
      messageId: messageRef.id,
      groupId,
      senderId: senderUid,
      text: type === "text" ? text.trim() : "",
      type,
      attachment,
      replyTo,
      edited: false,
      deleted: false,
      seenBy: [senderUid],
      createdAt: now,
      updatedAt: now,
    };

    // Build atomic unread-count increments for every member except the sender
    const unreadIncrements = {};
    membersSnapshot.docs.forEach((doc) => {
      const memberUid = doc.id;
      if (memberUid !== senderUid) {
        unreadIncrements[`unreadCount.${memberUid}`] =
          admin.firestore.FieldValue.increment(1);
      }
    });

    const lastMessagePreview =
      type === "text"
        ? text.trim()
        : `Sent ${type === "image" ? "an image" : `a ${type}`}`;

    await db.runTransaction(async (transaction) => {
      transaction.set(messageRef, messageData);

      transaction.update(groupRef, {
        lastMessage: lastMessagePreview,
        lastMessageSender: senderUid,
        lastMessageType: type,
        lastMessageTime: now,
        updatedAt: now,
        ...unreadIncrements,
      });
    });

    return res.status(201).json({
      success: true,
      message: "Group message sent successfully.",
      data: messageData,
    });
  } catch (error) {
    console.error("Send Group Message Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Mark Group Messages As Seen
 * PATCH /chat/group/message/seen/:groupId
 */
exports.markGroupMessagesAsSeen = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { groupId } = req.params;

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: "Group ID is required.",
      });
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Group not found.",
      });
    }

    const memberDoc = await groupRef.collection("members").doc(uid).get();

    if (!memberDoc.exists) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this group.",
      });
    }

    // Only fetch messages sent by others that this user hasn't seen yet.
    // Firestore doesn't support NOT array-contains, so we query by sender
    // and filter seenBy in memory. Limit to recent messages to keep reads bounded.
    const messagesSnapshot = await groupRef
      .collection("messages")
      .where("senderId", "!=", uid)
      .orderBy("senderId")
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const batch = db.batch();
    let updatedCount = 0;

    messagesSnapshot.docs.forEach((doc) => {
      const seenBy = doc.data().seenBy || [];

      if (!seenBy.includes(uid)) {
        // Use arrayUnion — atomic, no need to read the full array
        batch.update(doc.ref, {
          seenBy: admin.firestore.FieldValue.arrayUnion(uid),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        updatedCount++;
      }
    });

    // Reset this user's unread count atomically
    batch.update(groupRef, {
      [`unreadCount.${uid}`]: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      message: "Group messages marked as seen.",
    });
  } catch (error) {
    console.error("Mark Group Seen Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Edit Group Message
 * PATCH /chat/group/message/edit/:messageId
 */
exports.editGroupMessage = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { messageId } = req.params;
    const { groupId, text } = req.body;

    if (!groupId || !messageId) {
      return res.status(400).json({
        success: false,
        message: "Group ID and Message ID are required.",
      });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty.",
      });
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Group not found.",
      });
    }

    // Verify membership
    const memberDoc = await groupRef.collection("members").doc(uid).get();

    if (!memberDoc.exists) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this group.",
      });
    }

    const messageRef = groupRef.collection("messages").doc(messageId);
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
    console.error("Edit Group Message Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * Delete Group Message (soft delete)
 * DELETE /chat/group/message/delete/:messageId
 */
exports.deleteGroupMessage = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { messageId } = req.params;
    const { groupId } = req.body;

    if (!groupId || !messageId) {
      return res.status(400).json({
        success: false,
        message: "Group ID and Message ID are required.",
      });
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Group not found.",
      });
    }

    const messageRef = groupRef.collection("messages").doc(messageId);
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

    const group = groupDoc.data();
    const isLastMessage = group.lastMessageTime &&
      message.createdAt &&
      group.lastMessage === message.text &&
      group.lastMessageSender === uid;

    const updatePayload = {
      deleted: true,
      text: "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const groupUpdate = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // If deleting the message that is currently shown in the preview, clear it
    if (isLastMessage) {
      groupUpdate.lastMessage = "Message deleted";
      groupUpdate.lastMessageType = "system";
    }

    const batch = db.batch();
    batch.update(messageRef, updatePayload);
    batch.update(groupRef, groupUpdate);
    await batch.commit();

    return res.status(200).json({
      success: true,
      message: "Message deleted successfully.",
    });
  } catch (error) {
    console.error("Delete Group Message Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
