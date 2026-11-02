export interface ZenEngineOptions {
  loader?: (key: string) => Promise<Buffer | string | object> | Buffer | string | object;
}

export interface EvaluationOptions {
  trace?: boolean;
  maxDepth?: number;
}

export interface PerformanceDetails {
  durationNs: number;
  nodesExecuted: number;
}

export interface EvaluationResponse<T = any> {
  result: T;
  performance: string;
  performanceDetails?: PerformanceDetails;
  trace?: any[];
}

export class ZenDecisionContent {
  public data: Record<string, any>;
  public graph: Record<string, any>;
  constructor(content: Buffer | string | object);
}

export class ZenDecision {
  public readonly graph: Record<string, any>;
  constructor(content: ZenDecisionContent | Buffer | string | object, engine?: ZenEngine);
  evaluate<T = any>(context: Record<string, any>, options?: EvaluationOptions): Promise<EvaluationResponse<T>>;
  evaluateSync<T = any>(context: Record<string, any>, options?: EvaluationOptions): EvaluationResponse<T>;
  dispose(): void;
}

export class ZenEngine {
  constructor(options?: ZenEngineOptions);
  createDecision(content: ZenDecisionContent | Buffer | string | object): ZenDecision;
  getDecision(key: string): Promise<ZenDecision | null>;
  evaluate<T = any>(
    keyOrContent: string | Buffer | object,
    contentOrContext: Buffer | string | object,
    contextOrOptions?: Record<string, any>,
    options?: EvaluationOptions
  ): Promise<EvaluationResponse<T>>;
  dispose(): void;
}
