/**
 * razorpay.ts — Razorpay webhook integration for Nexus-402
 *
 * Flow:
 *   1. Razorpay fires payment.captured webhook → POST /api/v1/razorpay/webhook
 *   2. We verify HMAC-SHA256 signature using RAZORPAY_WEBHOOK_SECRET
 *   3. On success, Quant Agent fires an x402 sentiment analysis job
 *   4. Result (sentiment + proof hash) is stored keyed by payment_id
 *   5. GET /api/v1/razorpay/insights/:payment_id returns the audit record
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createLogger } from "../../../shared/logger";
import { executeX402Job } from "../x402/client";
import type { X402PaymentRequest, SentimentResult } from "../../../../shared-types";

const log = createLogger("razorpay-webhook");
export const razorpayRouter = Router();

// ── In-memory audit store (keyed by Razorpay payment_id) ──────────────────────
export type PaymentInsight = {
  paymentId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  merchantNotes?: string;
  capturedAt: number;
  x402JobId?: string;
  proofHash?: string;
  sentimentResult?: unknown;
  repricingRecommendation?: string;
  status: "pending" | "analysing" | "settled" | "failed";
  auditTrail: { ts: number; event: string; detail?: string }[];
};

export const insightStore = new Map<string, PaymentInsight>();

// ── Helpers ────────────────────────────────────────────────────────────────────

function verifyRazorpaySignature(
  rawBody: Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  // WHY: constant-time comparison prevents timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

function buildRepricingAdvice(
  sentiment: SentimentResult | undefined
): string {
  if (!sentiment) return "Insufficient data — hold current pricing.";
  if (sentiment.aggregateSentiment === "positive")
    return "Strong bullish sentiment detected. Consider +3-5% price buffer on high-demand SKUs.";
  if (sentiment.aggregateSentiment === "negative")
    return "Bearish signal. Maintain pricing, defer aggressive upsell campaigns.";
  return "Neutral sentiment. No repricing action required.";
}

// ── POST /api/v1/razorpay/webhook ─────────────────────────────────────────────
// Razorpay requires raw body for HMAC verification — use express.raw() for this route
razorpayRouter.post(
  "/webhook",
  // WHY: express.json() parses body; we need raw Buffer for HMAC
  (req: Request, res: Response, next) => {
    let data = Buffer.alloc(0);
    req.on("data", (chunk: Buffer) => { data = Buffer.concat([data, chunk]); });
    req.on("end", () => {
      (req as Request & { rawBody: Buffer }).rawBody = data;
      next();
    });
  },
  async (req: Request, res: Response) => {
    const wallet = (req as Request & { wallet: Keypair }).wallet;
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const webhookSecret = process.env["RAZORPAY_WEBHOOK_SECRET"] ?? "";

    // ── Signature verification ────────────────────────────────────────────────
    const rawBody = (req as Request & { rawBody: Buffer }).rawBody;

    if (!signature || !webhookSecret) {
      log.warn("Missing signature or webhook secret");
      res.status(400).json({ error: "Bad request" });
      return;
    }

    if (!verifyRazorpaySignature(rawBody, signature, webhookSecret)) {
      log.error("Webhook signature mismatch — possible spoofing attempt");
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    const event = JSON.parse(rawBody.toString()) as {
      event: string;
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            order_id?: string;
            amount?: number;
            currency?: string;
            description?: string;
            created_at?: number;
          };
        };
      };
    };

    log.info("Razorpay webhook received", { event: event.event });

    // ── Only handle payment.captured ──────────────────────────────────────────
    if (event.event !== "payment.captured") {
      res.json({ status: "ignored", event: event.event });
      return;
    }

    const payment = event.payload?.payment?.entity;
    if (!payment?.id) {
      res.status(400).json({ error: "Missing payment entity" });
      return;
    }

    const insight: PaymentInsight = {
      paymentId: payment.id,
      orderId: payment.order_id ?? "unknown",
      amountPaise: payment.amount ?? 0,
      currency: payment.currency ?? "INR",
      merchantNotes: payment.description,
      capturedAt: (payment.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
      status: "pending",
      auditTrail: [
        { ts: Date.now(), event: "payment.captured", detail: `₹${((payment.amount ?? 0) / 100).toFixed(2)} captured` },
      ],
    };

    insightStore.set(payment.id, insight);

    // Respond immediately to Razorpay — must be within 5s
    res.json({ status: "received", paymentId: payment.id });

    // ── Trigger x402 sentiment job asynchronously ─────────────────────────────
    triggerSentimentJob(wallet, payment.id, insight).catch((err: Error) => {
      log.error("x402 trigger failed", { error: err.message, paymentId: payment.id });
    });
  }
);

// ── Fire the x402 agent-to-agent job (runs after webhook response) ─────────────
async function triggerSentimentJob(
  wallet: Keypair,
  paymentId: string,
  insight: PaymentInsight
): Promise<void> {
  const analystEndpoint = process.env["ANALYST_AGENT_ENDPOINT"] ?? "http://localhost:3002";
  const analystPubkeyStr = process.env["ANALYST_WALLET_PUBKEY"];

  if (!analystPubkeyStr) {
    log.error("ANALYST_WALLET_PUBKEY not set — cannot disburse");
    insight.status = "failed";
    insight.auditTrail.push({ ts: Date.now(), event: "error", detail: "ANALYST_WALLET_PUBKEY not configured" });
    return;
  }

  let workerPubkey: PublicKey;
  try {
    workerPubkey = new PublicKey(analystPubkeyStr);
  } catch {
    insight.status = "failed";
    insight.auditTrail.push({ ts: Date.now(), event: "error", detail: "Invalid ANALYST_WALLET_PUBKEY" });
    return;
  }

  insight.status = "analysing";
  insight.auditTrail.push({ ts: Date.now(), event: "x402.started", detail: `Requesting sentiment from ${analystEndpoint}` });

  const request: X402PaymentRequest = {
    task: "sentiment_analysis",
    payload: {
      symbols: ["BTC", "ETH", "SOL"],
      lookbackHours: 24,
      source: "all",
      aggregation: "weighted_mean",
    },
    sla: {
      maxLatencyMs: 30_000,
      minConfidence: 0.6,
    },
  };

  log.info("Firing x402 job", { paymentId, analystEndpoint });

  const result = await executeX402Job(wallet, analystEndpoint, request, workerPubkey);

  if (!result.success) {
    insight.status = "failed";
    insight.auditTrail.push({ ts: Date.now(), event: "x402.failed", detail: result.error });
    log.error("x402 job failed", { paymentId, reason: result.reason });
    return;
  }

  // WHY: cast to access sentimentResult — callback may have it populated
  const cbResult = (result.callback as { result?: SentimentResult } | undefined)?.result;

  insight.x402JobId = result.jobId;
  insight.proofHash = result.proofHash;
  insight.sentimentResult = result.callback;
  insight.repricingRecommendation = buildRepricingAdvice(cbResult);
  insight.status = "settled";
  insight.auditTrail.push(
    { ts: Date.now(), event: "x402.settled", detail: `proofHash: ${result.proofHash?.slice(0, 16)}...` },
    { ts: Date.now(), event: "repricing.computed", detail: insight.repricingRecommendation }
  );

  log.info("Payment insight complete", { paymentId, status: "settled", recommendation: insight.repricingRecommendation });
}

// ── GET /api/v1/razorpay/insights/:payment_id ─────────────────────────────────
razorpayRouter.get("/insights/:paymentId", (req: Request, res: Response) => {
  const { paymentId } = req.params as { paymentId: string };
  const insight = insightStore.get(paymentId);
  if (!insight) {
    res.status(404).json({ error: "No insight found for this payment ID" });
    return;
  }
  res.json(insight);
});

// ── GET /api/v1/razorpay/insights ─────────────────────────────────────────────
// Returns all insights (for the demo dashboard)
razorpayRouter.get("/insights", (_req: Request, res: Response) => {
  res.json(Array.from(insightStore.values()));
});

// ── POST /api/v1/razorpay/simulate ────────────────────────────────────────────
// WHY: lets us demo without waiting for a real Razorpay payment (judges use this)
razorpayRouter.post("/simulate", async (req: Request, res: Response) => {
  const wallet = (req as Request & { wallet: Keypair }).wallet;
  const paymentId = `pay_DEMO_${Date.now()}`;

  log.info("Simulating payment.captured", { paymentId });

  const insight: PaymentInsight = {
    paymentId,
    orderId: `order_DEMO_${Date.now()}`,
    amountPaise: req.body?.amountPaise ?? 99900,
    currency: "INR",
    merchantNotes: "Demo payment — AI buildathon submission",
    capturedAt: Date.now(),
    status: "pending",
    auditTrail: [
      { ts: Date.now(), event: "payment.captured.simulated", detail: `₹${((req.body?.amountPaise ?? 99900) / 100).toFixed(2)} simulated` },
    ],
  };

  insightStore.set(paymentId, insight);
  res.json({ status: "simulated", paymentId, trackUrl: `/api/v1/razorpay/insights/${paymentId}` });

  triggerSentimentJob(wallet, paymentId, insight).catch((err: Error) => {
    log.error("Simulated x402 trigger failed", { error: err.message });
  });
});
