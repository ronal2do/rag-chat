import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { RunnableSequence, RunnableWithMessageHistory } from "@langchain/core/runnables";
import { StreamingTextResponse, LangChainStream } from "ai";

import type { PrepareChatResult, ChatOptions } from "./types";
import { sanitizeQuestion, formatChatHistory } from "./utils";
import type { BaseLanguageModelInterface } from "@langchain/core/language_models/base";
import type { PromptTemplate } from "@langchain/core/prompts";
import type { HistoryService, RetrievePayload } from "./services";
import type { RetrievalService } from "./services/retrieval";

type CustomInputValues = { chat_history?: BaseMessage[]; question: string; context: string };

export class RAGChatBase {
  protected retrievalService: RetrievalService;
  protected historyService: HistoryService;

  #model: BaseLanguageModelInterface;
  #template: PromptTemplate;

  constructor(
    retrievalService: RetrievalService,
    historyService: HistoryService,
    config: { model: BaseLanguageModelInterface; template: PromptTemplate }
  ) {
    this.retrievalService = retrievalService;
    this.historyService = historyService;

    this.#model = config.model;
    this.#template = config.template;
  }

  protected async prepareChat({
    question: input,
    similarityThreshold,
    topK,
    metadataKey,
  }: RetrievePayload): Promise<PrepareChatResult> {
    const question = sanitizeQuestion(input);
    const facts = await this.retrievalService.retrieveFromVectorDb({
      question,
      similarityThreshold,
      metadataKey,
      topK,
    });
    return { question, facts };
  }

  protected streamingChainCall = (
    chatOptions: ChatOptions,
    question: string,
    facts: string
  ): StreamingTextResponse => {
    const { stream, handlers } = LangChainStream();
    void this.chainCall(chatOptions, question, facts, [handlers]);
    return new StreamingTextResponse(stream, {});
  };

  protected chainCall(
    chatOptions: ChatOptions,
    question: string,
    facts: string,
    handlers?: Callbacks
  ): Promise<AIMessage> {
    const formattedHistoryChain = RunnableSequence.from<CustomInputValues>([
      {
        chat_history: (input) => formatChatHistory(input.chat_history ?? []),
        question: (input) => input.question,
        context: (input) => input.context,
      },
      this.#template,
      this.#model,
    ]);

    const chainWithMessageHistory = new RunnableWithMessageHistory({
      runnable: formattedHistoryChain,
      getMessageHistory: (sessionId: string) =>
        this.historyService.getMessageHistory({
          sessionId,
          length: chatOptions.historyLength,
        }),
      inputMessagesKey: "question",
      historyMessagesKey: "chat_history",
    });

    return chainWithMessageHistory.invoke(
      {
        question,
        context: facts,
      },
      {
        callbacks: handlers ?? undefined,
        configurable: { sessionId: chatOptions.sessionId },
      }
    ) as Promise<AIMessage>;
  }
}