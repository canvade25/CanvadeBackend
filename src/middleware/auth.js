const jwt = require("jsonwebtoken");
const { admin, db } = require("../services/firebase");

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Access token required" });
    }

    const token = authHeader.split(" ")[1];

    let decodedUid = null;

    // Try Firebase ID token first
    try {
      const decodedIdToken = await admin.auth().verifyIdToken(token);
      decodedUid = decodedIdToken.uid;
    } catch (firebaseErr) {
      // Only fall back to JWT for explicitly-issued server tokens,
      // not as a transparent fallback for any Firebase failure.
      if (!process.env.JWT_SECRET) {
        return res.status(401).json({ success: false, message: "Invalid token" });
      }

      try {
        const decodedJwt = jwt.verify(token, process.env.JWT_SECRET);
        // Ensure the JWT was issued by this server (must carry the `src` claim)
        if (decodedJwt.src !== "server") {
          return res.status(401).json({ success: false, message: "Invalid token" });
        }
        decodedUid = decodedJwt.uid;
      } catch (jwtErr) {
        if (
          firebaseErr &&
          (firebaseErr.code === "auth/id-token-expired" ||
            firebaseErr.errorInfo?.code === "auth/id-token-expired")
        ) {
          return res.status(401).json({ success: false, message: "Token expired" });
        }
        if (jwtErr.name === "TokenExpiredError") {
          return res.status(401).json({ success: false, message: "Token expired" });
        }
        return res.status(401).json({ success: false, message: "Invalid token" });
      }
    }

    const userSnapshot = await db.collection("users").doc(decodedUid).get();

    if (!userSnapshot.exists) {
      return res.status(401).json({ success: false, message: "User not found" });
    }

    const user = userSnapshot.data();

    // Use the token-verified UID as the authoritative identity — never the
    // stored uid field, which could be missing or stale.
    req.user = {
      uid: decodedUid,
      email: user.email || null,
      role: user.role || null,
      displayName: user.displayName || null,
      studentId: user.studentId || null,
      instituteId: user.instituteId || null,
      teacherId: user.teacherId || null,
    };

    next();
  } catch (error) {
    console.error("Auth Error:", error);
    return res.status(401).json({ success: false, message: "Authentication failed" });
  }
};

module.exports = auth;
