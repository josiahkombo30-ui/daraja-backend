const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Temporary in-memory transaction storage.
// We can replace this with a database later if needed.
const transactions = new Map();

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Daraja M-PESA Backend"
  });
});

// --------------------------------------------------
// GET DARAJA ACCESS TOKEN
// --------------------------------------------------

async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );

  return response.data.access_token;
}

// --------------------------------------------------
// CREATE STK PASSWORD
// --------------------------------------------------

function createTimestamp() {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

// --------------------------------------------------
// STK PUSH
// --------------------------------------------------

app.post("/api/payment/stkpush", async (req, res) => {
  try {
    const { phoneNumber, amount, plan } = req.body;

    if (!phoneNumber || !amount || !plan) {
      return res.status(400).json({
        success: false,
        message: "Phone number, amount and plan are required."
      });
    }

    // Only allow the two subscription plans.
    const plans = {
      "2_DAYS": {
        amount: 55,
        durationDays: 2
      },
      "7_DAYS": {
        amount: 100,
        durationDays: 7
      }
    };

    const selectedPlan = plans[plan];

    if (!selectedPlan) {
      return res.status(400).json({
        success: false,
        message: "Invalid subscription plan."
      });
    }

    if (Number(amount) !== selectedPlan.amount) {
      return res.status(400).json({
        success: false,
        message: "Incorrect amount for selected subscription plan."
      });
    }

    const accessToken = await getAccessToken();

    const timestamp = createTimestamp();

    const password = Buffer.from(
      `${process.env.DARAJA_SHORTCODE}${process.env.DARAJA_PASSKEY}${timestamp}`
    ).toString("base64");

    const requestBody = {
      BusinessShortCode: process.env.DARAJA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: process.env.DARAJA_TRANSACTION_TYPE || "CustomerPayBillOnline",
      Amount: selectedPlan.amount,
      PartyA: phoneNumber,
      PartyB: process.env.DARAJA_SHORTCODE,
      PhoneNumber: phoneNumber,
      CallBackURL: process.env.DARAJA_CALLBACK_URL,
      AccountReference: "JOSMS",
      TransactionDesc: `${selectedPlan.durationDays} Day Subscription`
    };

    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const result = response.data;

    if (result.ResponseCode !== "0") {
      return res.status(400).json({
        success: false,
        message: result.ResponseDescription || "STK Push failed.",
        darajaResponse: result
      });
    }

    transactions.set(result.CheckoutRequestID, {
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      phoneNumber,
      amount: selectedPlan.amount,
      plan,
      durationDays: selectedPlan.durationDays,
      status: "PENDING",
      createdAt: new Date().toISOString()
    });

    return res.json({
      success: true,
      message: "M-PESA payment prompt sent.",
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      customerMessage: result.CustomerMessage
    });

  } catch (error) {
    console.error(
      "STK Push error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      message: "Unable to initiate M-PESA payment."
    });
  }
});

// --------------------------------------------------
// DARAJA CALLBACK
// --------------------------------------------------

app.post("/api/payment/callback", (req, res) => {
  console.log(
    "M-PESA CALLBACK:",
    JSON.stringify(req.body, null, 2)
  );

  const callback =
    req.body?.Body?.stkCallback;

  if (!callback) {
    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }

  const checkoutRequestId = callback.CheckoutRequestID;

  const transaction = transactions.get(checkoutRequestId);

  if (transaction) {
    if (callback.ResultCode === 0) {
      transaction.status = "SUCCESSFUL";
      transaction.resultCode = callback.ResultCode;
      transaction.resultDesc = callback.ResultDesc;
      transaction.completedAt = new Date().toISOString();

      const metadata =
        callback.CallbackMetadata?.Item || [];

      transaction.metadata = metadata;
    } else {
      transaction.status = "FAILED";
      transaction.resultCode = callback.ResultCode;
      transaction.resultDesc = callback.ResultDesc;
      transaction.completedAt = new Date().toISOString();
    }

    transactions.set(checkoutRequestId, transaction);
  }

  return res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

// --------------------------------------------------
// CHECK PAYMENT STATUS
// --------------------------------------------------

app.get("/api/payment/status/:checkoutRequestId", (req, res) => {
  const transaction = transactions.get(
    req.params.checkoutRequestId
  );

  if (!transaction) {
    return res.status(404).json({
      success: false,
      status: "NOT_FOUND"
    });
  }

  return res.json({
    success: true,
    status: transaction.status,
    transaction
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Daraja backend running on port ${PORT}`);
});
