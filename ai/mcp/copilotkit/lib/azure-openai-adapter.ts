import {
  CopilotRuntimeChatCompletionRequest,
  CopilotRuntimeChatCompletionResponse,
  OpenAIAdapter,
  OpenAIAdapterParams,
} from '@copilotkit/runtime';
import { randomId, randomUUID } from '@copilotkit/shared';
import { APIError, RateLimitError } from 'openai/error';

type HeadersLike = Headers | Record<string, string | number | undefined> | undefined;

type RateLimitLikeError = (RateLimitError | APIError) & {
  headers?: HeadersLike;
  message: string;
};

interface RetryableRateLimit {
  retryAfterMs?: number;
  message?: string;
}

export interface AzureOpenAIAdapterParams extends OpenAIAdapterParams {
  /**
   * Maximum number of attempts (including the first try).
   * Defaults to 1 (no automatic retries).
   */
  maxAttempts?: number;
  /**
   * Largest Retry-After value we are willing to wait for automatically.
   * Defaults to 15 seconds.
   */
  maxRetryWaitMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_MAX_RETRY_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AzureOpenAIAdapter extends OpenAIAdapter {
  private readonly maxAttempts: number;
  private readonly maxRetryWaitMs: number;

  constructor(params: AzureOpenAIAdapterParams = {}) {
    const { maxAttempts, maxRetryWaitMs, ...rest } = params;
    super(rest);
    this.maxAttempts = Math.max(maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1);
    this.maxRetryWaitMs = maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
  }

  async process(
    request: CopilotRuntimeChatCompletionRequest,
  ): Promise<CopilotRuntimeChatCompletionResponse> {
    const threadId = request.threadId ?? randomUUID();

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        return await super.process({ ...request, threadId });
      } catch (error) {
        const rateLimit = this.extractRateLimit(error);
        if (!rateLimit) {
          throw error;
        }

        const hasAnotherAttempt = attempt < this.maxAttempts - 1;
        const retryAfterMs = rateLimit.retryAfterMs;

        if (hasAnotherAttempt && retryAfterMs !== undefined && retryAfterMs <= this.maxRetryWaitMs) {
          console.warn(
            `Azure OpenAI rate limit hit. Retrying in ${Math.ceil(retryAfterMs / 1000)}s (attempt ${
              attempt + 2
            }/${this.maxAttempts}).`,
          );
          await sleep(retryAfterMs);
          continue;
        }

        this.sendRateLimitMessage(request, rateLimit.message, retryAfterMs);
        return { threadId };
      }
    }

    throw new Error('AzureOpenAIAdapter reached an unexpected state.');
  }

  private extractRateLimit(error: unknown): RetryableRateLimit | null {
    if (!this.isRateLimitError(error)) {
      return null;
    }

    const retryAfterMs = this.parseRetryAfterMs(error.headers);
    const message = this.composeRateLimitMessage(error.message, retryAfterMs);

    return { retryAfterMs, message };
  }

  private isRateLimitError(error: unknown): error is RateLimitLikeError {
    if (!(error instanceof Error)) {
      return false;
    }

    if (error instanceof RateLimitError) {
      return true;
    }

    if (error instanceof APIError && error.status === 429) {
      return true;
    }

    return false;
  }

  private parseRetryAfterMs(headers: HeadersLike): number | undefined {
    const retryAfterMs = this.getHeaderNumber(headers, 'retry-after-ms');
    if (retryAfterMs !== undefined) {
      return retryAfterMs;
    }

    const retryAfterSeconds = this.getHeaderNumber(headers, 'retry-after');
    if (retryAfterSeconds !== undefined) {
      return retryAfterSeconds * 1000;
    }

    return undefined;
  }

  private getHeaderNumber(headers: HeadersLike, name: string): number | undefined {
    const raw = this.getHeaderValue(headers, name);
    if (!raw) {
      return undefined;
    }

    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  private getHeaderValue(headers: HeadersLike, name: string): string | undefined {
    if (!headers) {
      return undefined;
    }

    if (typeof (headers as Headers).get === 'function') {
      const headerBag = headers as Headers;
      return (
        headerBag.get(name) ||
        headerBag.get(name.toLowerCase()) ||
        headerBag.get(name.toUpperCase()) ||
        undefined
      ) as string | undefined;
    }

    const lowered = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, string | number | undefined>)) {
      if (key.toLowerCase() === lowered && value !== undefined) {
        return String(value);
      }
    }

    return undefined;
  }

  private composeRateLimitMessage(detail: string | undefined, retryAfterMs: number | undefined): string {
    const waitSeconds = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 60;
    const trimmedDetail = detail?.trim();

    const lines = [
      'Azure OpenAI is currently rate limiting requests, so I could not complete the last action.',
      `Please retry in about ${waitSeconds} seconds.`,
      'If this keeps happening consider requesting a quota increase: https://aka.ms/oai/quotaincrease.',
    ];

    if (trimmedDetail && !trimmedDetail.startsWith('Azure OpenAI is currently rate limiting')) {
      lines.unshift(trimmedDetail);
    }

    return lines.join('\n');
  }

  private sendRateLimitMessage(
    request: CopilotRuntimeChatCompletionRequest,
    message: string | undefined,
    retryAfterMs: number | undefined,
  ): void {
    const waitSeconds = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : undefined;
    const humanReadable = message ?? this.composeRateLimitMessage(undefined, retryAfterMs);

    console.warn(
      `Azure OpenAI rate limit reached. Informing client${
        waitSeconds ? `; suggested wait ${waitSeconds}s.` : '.'
      }`,
    );

    request.eventSource.stream(async (eventStream$) => {
      const messageId = randomId();
      eventStream$.sendTextMessageStart({ messageId });
      eventStream$.sendTextMessageContent({ messageId, content: humanReadable });
      eventStream$.sendTextMessageEnd({ messageId });
      eventStream$.complete();
    });
  }
}
