# Nexus-402: Agentic Commerce Engine

Nexus-402 is an AI-driven, agentic middleware designed to dynamically interact with the Razorpay API. It uses a network of autonomous agents to monitor payment webhooks, analyze market sentiment, and dynamically recommend repricing strategies based on real-time data.

Built for the **Razorpay Buildathon (Track 01: AI Growth & Agentic Commerce)**.

## Architecture

The system consists of three main components:
1. **Frontend Dashboard**: A Next.js-powered React UI that provides a live telemetry feed of all Razorpay webhook events, along with real-time AI sentiment and repricing metrics.
2. **Quant Agent**: The orchestrator node. It securely exposes a webhook endpoint, verifies the Razorpay HMAC signature, and triggers asynchronous analysis tasks.
3. **Analyst Agent**: A specialized worker node that performs sentiment analysis on the data payload, generates cryptographic proofs of its inference, and computes dynamic repricing recommendations.

## Local Setup Instructions

To run this project locally, you will need Node.js installed, as well as Cloudflared for webhook tunneling.

### 1. Install Dependencies
```bash
# Install frontend dependencies
cd frontend
npm install

# Install agent dependencies
cd ../agents
npm install
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory (based on `.env.example`) and add your Razorpay credentials. 

### 3. Start the Agents
You need to run both the Quant and Analyst agents. Open two terminal windows and run:

Terminal 1:
```bash
cd agents
npm run dev:analyst
```

Terminal 2:
```bash
cd agents
npm run dev:quant
```

### 4. Start the Frontend Dashboard
Open a third terminal window to start the Next.js UI:
```bash
cd frontend
npm run dev
```

### 5. Expose Webhook via Cloudflare (Optional for Testing)
To receive real webhooks from Razorpay, expose the Quant agent (running on port 3001) to the internet:
```bash
cloudflared tunnel --url http://localhost:3001
```
Use the generated Cloudflare URL in your Razorpay Dashboard Webhook settings, pointing to `https://<YOUR_URL>/api/v1/razorpay/webhook`.

You can also test the system without a tunnel by clicking the **Simulate Webhook** button on the frontend dashboard!

## Features

- **Live Razorpay Webhook Ingestion**: Securely processes `payment.captured` and other events.
- **Dynamic Repricing**: AI models generate repricing advice based on transaction data.
- **Agentic Escrow & Proofs**: The Analyst agent generates cryptographic hashes as proof of inference for every task.
- **Cyberpunk Telemetry UI**: A stunning, real-time dashboard visualizing the algorithmic lifecycle of your payments.
