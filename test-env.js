import dotenv from "dotenv";
dotenv.config({ path: "environments/.env" });

console.log("✅ OPENAI key:", process.env.OPENAI_API_KEY);
console.log("✅ Twilio SID:", process.env.TWILIO_ACCOUNT_SID);
console.log("✅ Base URL:", process.env.BASE_URL);

