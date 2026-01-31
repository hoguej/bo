/**
 * Hybrid AI Model Selection Strategy
 * 
 * Routes tasks to appropriate models based on complexity:
 * - Simple tasks → Gemini 3 Flash (cheap, fast)
 * - Standard tasks → GPT-4.1 (balanced)
 * - Complex/safety tasks → GPT-5.2 (most capable)
 */

export type TaskType = 
  | 'extract_date'
  | 'parse_time'
  | 'simple_acknowledgment'
  | 'list_format'
  | 'personality_response'
  | 'red_flag_detection'
  | 'crisis_response'
  | 'code_generation'
  | 'fact_extraction'
  | 'conversation'
  | 'skill_routing'
  | 'summary_generation';

/**
 * Select the appropriate model for a given task type
 */
export function selectModel(taskType: TaskType): string {
  const simpleTasks: TaskType[] = [
    'extract_date',
    'parse_time',
    'simple_acknowledgment',
    'list_format',
  ];

  const complexTasks: TaskType[] = [
    'personality_response',
    'red_flag_detection',
    'crisis_response',
    'code_generation',
  ];

  if (simpleTasks.includes(taskType)) {
    return process.env.BO_SIMPLE_MODEL || 'google/gemini-3-flash';
  }

  if (complexTasks.includes(taskType)) {
    return process.env.BO_COMPLEX_MODEL || 'openai/gpt-5.2';
  }

  // Default: standard tasks use GPT-4.1
  return process.env.BO_LLM_MODEL || 'openai/gpt-4.1';
}

/**
 * Get model configuration for API calls
 */
export function getModelConfig(taskType: TaskType) {
  const model = selectModel(taskType);
  
  // Parse provider and model name
  const [provider, ...modelParts] = model.split('/');
  const modelName = modelParts.join('/');

  return {
    model,
    provider,
    modelName,
    isOpenAI: provider === 'openai',
    isGoogle: provider === 'google',
  };
}

/**
 * Estimate cost for a task (in USD per 1K tokens)
 */
export function estimateTaskCost(taskType: TaskType): { input: number; output: number } {
  const model = selectModel(taskType);

  // Pricing per 1K tokens (as of 2026)
  const pricing: Record<string, { input: number; output: number }> = {
    'google/gemini-3-flash': { input: 0.00001, output: 0.00002 }, // $0.01/$0.02 per 1M
    'openai/gpt-4.1': { input: 0.01, output: 0.03 }, // $10/$30 per 1M
    'openai/gpt-5.2': { input: 0.02, output: 0.06 }, // $20/$60 per 1M
  };

  return pricing[model] || { input: 0.01, output: 0.03 };
}
