/**
 * Gemini-specific Request Transformations
 * 
 * Handles Gemini model-specific request transformations including:
 * - Thinking config (camelCase keys, thinkingLevel for Gemini 3)
 * - Tool normalization (function/custom format)
 */

import type { RequestPayload, ThinkingConfig, ThinkingTier } from "./types";

/**
 * Check if a model is a Gemini model (not Claude).
 */
export function isGeminiModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("gemini") && !lower.includes("claude");
}

/**
 * Check if a model is Gemini 3 (uses thinkingLevel string).
 */
export function isGemini3Model(model: string): boolean {
  return model.toLowerCase().includes("gemini-3");
}

/**
 * Check if a model is Gemini 2.5 (uses numeric thinkingBudget).
 */
export function isGemini25Model(model: string): boolean {
  return model.toLowerCase().includes("gemini-2.5");
}

/**
 * Build Gemini 3 thinking config with thinkingLevel string.
 */
export function buildGemini3ThinkingConfig(
  includeThoughts: boolean,
  thinkingLevel: ThinkingTier,
): ThinkingConfig {
  return {
    includeThoughts,
    thinkingLevel,
  };
}

/**
 * Build Gemini 2.5 thinking config with numeric thinkingBudget.
 */
export function buildGemini25ThinkingConfig(
  includeThoughts: boolean,
  thinkingBudget?: number,
): ThinkingConfig {
  return {
    includeThoughts,
    ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
  };
}

/**
 * Normalize tools for Gemini models.
 * Converts various tool formats to functionDeclarations format (same as Claude).
 * 
 * @returns Debug info about tool normalization
 */
export function normalizeGeminiTools(
  payload: RequestPayload,
): { toolDebugMissing: number; toolDebugSummaries: string[] } {
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];

  if (!Array.isArray(payload.tools)) {
    return { toolDebugMissing, toolDebugSummaries };
  }

  const functionDeclarations: unknown[] = [];
  const passthroughTools: unknown[] = [];

  const placeholderSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      _placeholder: {
        type: "boolean",
        description: "Placeholder. Always pass true.",
      },
    },
    required: ["_placeholder"],
  };

  const normalizeSchema = (schema: unknown): Record<string, unknown> => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      toolDebugMissing += 1;
      return { ...placeholderSchema };
    }

    const cleaned = { ...(schema as Record<string, unknown>) };
    
    // Remove $schema field that Gemini doesn't accept
    delete cleaned.$schema;

    // Ensure type is object
    cleaned.type = "object";

    // Ensure properties exist
    const hasProperties =
      cleaned.properties &&
      typeof cleaned.properties === "object" &&
      Object.keys(cleaned.properties as Record<string, unknown>).length > 0;

    if (!hasProperties) {
      cleaned.properties = {
        _placeholder: {
          type: "boolean",
          description: "Placeholder. Always pass true.",
        },
      };
      cleaned.required = ["_placeholder"];
    }

    return cleaned;
  };

  (payload.tools as unknown[]).forEach((tool: unknown) => {
    const t = tool as Record<string, unknown>;

    const pushDeclaration = (decl: Record<string, unknown> | undefined, source: string): void => {
      const schema =
        decl?.parameters ||
        decl?.parametersJsonSchema ||
        decl?.input_schema ||
        decl?.inputSchema ||
        t.parameters ||
        t.parametersJsonSchema ||
        t.input_schema ||
        t.inputSchema ||
        (t.function as Record<string, unknown> | undefined)?.parameters ||
        (t.function as Record<string, unknown> | undefined)?.input_schema ||
        (t.custom as Record<string, unknown> | undefined)?.parameters ||
        (t.custom as Record<string, unknown> | undefined)?.input_schema;

      let name =
        decl?.name ||
        t.name ||
        (t.function as Record<string, unknown> | undefined)?.name ||
        (t.custom as Record<string, unknown> | undefined)?.name ||
        `tool-${functionDeclarations.length}`;

      // Sanitize tool name: must be alphanumeric with underscores
      name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

      const description =
        decl?.description ||
        t.description ||
        (t.function as Record<string, unknown> | undefined)?.description ||
        (t.custom as Record<string, unknown> | undefined)?.description ||
        "";

      functionDeclarations.push({
        name,
        description: String(description || ""),
        parameters: normalizeSchema(schema),
      });

      toolDebugSummaries.push(
        `decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`,
      );
    };

    // Check for functionDeclarations array first
    if (Array.isArray(t.functionDeclarations) && (t.functionDeclarations as unknown[]).length > 0) {
      (t.functionDeclarations as Record<string, unknown>[]).forEach((decl) => 
        pushDeclaration(decl, "functionDeclarations")
      );
      return;
    }

    // Fall back to function/custom style definitions
    if (t.function || t.custom || t.parameters || t.input_schema || t.inputSchema || t.name) {
      pushDeclaration(
        (t.function as Record<string, unknown> | undefined) ?? 
        (t.custom as Record<string, unknown> | undefined) ?? 
        t,
        "function/custom"
      );
      return;
    }

    // Preserve any non-function tool entries (e.g., codeExecution) untouched
    passthroughTools.push(tool);
  });

  const finalTools: unknown[] = [];
  if (functionDeclarations.length > 0) {
    finalTools.push({ functionDeclarations });
  }
  payload.tools = finalTools.concat(passthroughTools);

  return { toolDebugMissing, toolDebugSummaries };
}

/**
 * Apply all Gemini-specific transformations to a request payload.
 */
export interface GeminiTransformOptions {
  /** The effective model name (resolved) */
  model: string;
  /** Tier-based thinking budget (from model suffix, for Gemini 2.5) */
  tierThinkingBudget?: number;
  /** Tier-based thinking level (from model suffix, for Gemini 3) */
  tierThinkingLevel?: ThinkingTier;
  /** Normalized thinking config from user settings */
  normalizedThinking?: { includeThoughts?: boolean; thinkingBudget?: number };
}

export interface GeminiTransformResult {
  toolDebugMissing: number;
  toolDebugSummaries: string[];
}

/**
 * Apply all Gemini-specific transformations.
 */
export function applyGeminiTransforms(
  payload: RequestPayload,
  options: GeminiTransformOptions,
): GeminiTransformResult {
  const { model, tierThinkingBudget, tierThinkingLevel, normalizedThinking } = options;

  // 1. Apply thinking config if needed
  if (normalizedThinking) {
    let thinkingConfig: ThinkingConfig;

    if (tierThinkingLevel && isGemini3Model(model)) {
      // Gemini 3 uses thinkingLevel string
      thinkingConfig = buildGemini3ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        tierThinkingLevel,
      );
    } else {
      // Gemini 2.5 and others use numeric budget
      const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
      thinkingConfig = buildGemini25ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        thinkingBudget,
      );
    }

    const generationConfig = (payload.generationConfig ?? {}) as Record<string, unknown>;
    generationConfig.thinkingConfig = thinkingConfig;
    payload.generationConfig = generationConfig;
  }

  // 2. Normalize tools
  return normalizeGeminiTools(payload);
}
