import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { Agent, fetch as undiciFetch } from "undici";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;
let oauthToken: string | null = null;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const openAiCompatibleModel = createOpenAICompatible({
    name: "example",
    baseURL: process.env.MODEL_BASE_URL!,
    fetch: customFetch,
  })(process.env.MODEL_NAME!, {});

  const streamArgs = {
    model: openAiCompatibleModel,
    messages,
    frequencyPenalty: 1,
    maxTokens: 1024,
    temperature: 0.9,
    topP: 0.9,
  };

  const result = streamText(streamArgs);

  return result.toDataStreamResponse();
}

async function customFetch(
  input: URL | RequestInfo,
  init?: RequestInit
): Promise<Response> {
  try {
    const oauthToken = await getOrRefreshOauthToken();

    // Create SSL agent with client certificates
    const agent = new Agent({
      connect: {
        rejectUnauthorized: false,
        key: process.env.SSL_KEY!,
        cert: process.env.SSL_CERT!,
        passphrase: process.env.SSL_PASSPHRASE!,
      },
    });

    // Prepare headers properly
    const headers: Record<string, string> = {
      Authorization: `Bearer ${oauthToken}`,
      "Content-Type": "application/json",
      "x-requestor-id": process.env.REQUESTOR_ID!,
    };

    // Merge additional headers
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        for (const [key, value] of init.headers.entries()) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    const response = await undiciFetch(input.toString(), {
      method: init?.method || "POST",
      headers,
      // @ts-expect-error yolo
      body: init?.body,
      dispatcher: agent,
      signal: init?.signal,
    });

    // Handle the response properly
    if (!response.ok) {
      const errorText = await response.text();
      console.error("API: Error response:", response.status, errorText);
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}. Body: ${errorText}`
      );
    }

    const responseText = await response.text();

    let fixedResponseText = responseText;
    try {
      fixedResponseText = JSON.parse(responseText);
    } catch {
      console.error("Unable to parse response as JSON", responseText);
    }

    const standardResponse = new Response(fixedResponseText, {
      status: response.status,
      statusText: response.statusText,
      // @ts-expect-error yolo
      headers: new Headers(response.headers),
    });

    return standardResponse;
  } catch (error) {
    console.error("API request failed:", error);
    // Provide more detailed error information
    if (error instanceof Error) {
      console.error("Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    }
    throw error;
  }
}

async function getOrRefreshOauthToken(): Promise<string> {
  try {
    // Hacky in-memory cache for oauth token
    if (oauthToken != null) {
      return oauthToken;
    }

    const oauthReply = await fetch(process.env.OAUTH_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.OAUTH_CLIENT_ID!,
        client_secret: process.env.OAUTH_CLIENT_SECRET!,
        grant_type: process.env.OAUTH_GRANT_TYPE!,
        scope: process.env.OAUTH_SCOPE!,
        resource: process.env.OAUTH_RESOURCE!,
      }),
    });

    if (!oauthReply.ok) {
      const errorBody = await oauthReply.text();
      throw new Error(`OAuth failed: ${oauthReply.status} ${errorBody}`);
    }

    const oauthJson = (await oauthReply.json()) as { access_token?: string };
    oauthToken = oauthJson?.access_token ?? null;
    if (!oauthToken) {
      throw new Error("No access_token in OAuth response");
    }

    return oauthToken;
  } catch (error) {
    console.error("OAuth token refresh failed:", error);
    throw error;
  }
}
