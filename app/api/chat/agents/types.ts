import { ModelMessage} from 'ai';

export interface AgentContext {
  messages: ModelMessage[];
  // Optional: original UI messages (with `parts`) used by UI-stream helpers.
  // When missing, agents should derive a minimal UI representation from `messages`.
  uiMessages?: any[];
  userPrompt: string | null;
  userId?: string | null;
  conversationId?: string | null;
  documentContent?: string; // State Injection
  model: any; // The language model instance
}

export interface AgentResponse {
  stream: ReadableStream;
}

/**
 * ============================================================================
 * SGR-схемы для всех агентов (Schema-Guided Reasoning)
 * ============================================================================
 * 
 * Эти схемы используются для структурирования рассуждений AI-агентов.
 * Каждая схема определяет обязательные этапы обработки (cascade),
 * циклические проверки (cycle), маршрутизацию (routing) и верификацию.
 */

// ----------------------------------------------------------------------------
// SGR для проверки документов (review-agent)
// ----------------------------------------------------------------------------
export interface SgrDocumentReview {
  /** Этап 1: Подготовка и нормализация */
  stage_1_input_analysis: {
    original_length: number;
    normalized_content: string;
    normalization_issues: string[];
  };

  /** Этап 2: Cascade - Проверка структуры (10 разделов) */
  stage_2_structure_cascade: {
    found_sections: Array<{
      section_number: number;
      section_name: string;
      has_content: boolean;
      content_preview: string;
    }>;
    missing_sections: number[];
    empty_sections: number[];
  };

  /** Этап 3: Cycle - Детальная проверка каждого раздела */
  stage_3_section_cycle: {
    section_checks: Array<{
      section: string;
      checks_performed: string[];
      issues_found: Array<{
        type: 'error' | 'warning';
        description: string;
        evidence: string;
      }>;
    }>;
  };

  /** Этап 4: Routing - Классификация и верификация ошибок */
  stage_4_error_routing: {
    errors: Array<{
      category: 'structure' | 'format' | 'encoding' | 'content' | 'style';
      section: string;
      issue: string;
      suggestion: string;
      confidence: 'high' | 'medium' | 'low';
    }>;
    warnings: Array<{
      category: 'format' | 'style' | 'terminology' | 'punctuation';
      section: string;
      issue: string;
      suggestion: string;
      confidence: 'high' | 'medium' | 'low';
    }>;
    info: Array<{
      category: 'quality' | 'completeness';
      description: string;
    }>;
  };

  /** Этап 5: Дедупликация и консолидация */
  stage_5_deduplication: {
    duplicates_found: string[];
    merged_issues: string[];
    final_issues_count: {
      errors: number;
      warnings: number;
      info: number;
    };
  };

  /** Этап 6: Финальная верификация */
  stage_6_verification: {
    verification_checks: string[];
    confirmed_issues: number;
    rejected_issues: number;
    final_verdict: {
      isValid: boolean;
      summary: string;
    };
  };

  /** Этап 7: Формирование ответа */
  stage_7_output: {
    isValid: boolean;
    issues: Array<{
      level: 'error' | 'warning' | 'info';
      section: string;
      issue: string;
      suggestion: string;
    }>;
    summary: string;
  };
}

// ----------------------------------------------------------------------------
// SGR для исправления замечаний (chat-agent fix issues)
// ----------------------------------------------------------------------------
export interface SgrFixIssues {
  /** Этап 1: Анализ замечаний */
  stage_1_analysis: {
    total_issues: number;
    issues_by_category: {
      structure: number;
      formatting: number;
      content: number;
      style: number;
      other: number;
    };
    critical_issues: string[];
  };

  /** Этап 2: Cascade - Пошаговое исправление */
  stage_2_fixes_cascade: Array<{
    issue_number: number;
    issue_text: string;
    category: 'structure' | 'formatting' | 'content' | 'style' | 'other';
    location_found: boolean;
    fix_description: string;
    status: 'fixed' | 'requires_clarification' | 'cannot_fix';
  }>;

  /** Этап 3: Верификация исправлений */
  stage_3_verification: {
    critical_issues_resolved: boolean;
    structure_preserved: boolean;
    style_preserved: boolean;
    unclear_issues: string[];
    additional_fixes: string[];
  };

  /** Этап 4: Формирование ответа */
  stage_4_output: {
    fixed_issues: string[];
    needs_clarification: string[];
    corrected_document: string;
  };
}

// ----------------------------------------------------------------------------
// SGR для генерации протокола (document-agent)
// ----------------------------------------------------------------------------
export interface SgrProtocolGeneration {
  /** Этап 1: Анализ исходных данных */
  stage_1_data_analysis: {
    data_source: 'transcript_only' | 'document_only' | 'transcript_and_document';
    facts_from_transcript: string[];
    data_from_document: string[];
    conflicts: string[];
    missing_critical_data: string[];
  };

  /** Этап 2: Cascade - Проверка структуры */
  stage_2_structure_cascade: {
    sections_check: Array<{
      section_number: number;
      section_name: string;
      has_data: boolean;
      data_completeness: 'complete' | 'partial' | 'missing';
      source: 'transcript' | 'document' | 'both' | 'inferred';
    }>;
    sections_with_missing_data: number[];
  };

  /** Этап 3: Cycle - Детальная проверка */
  stage_3_section_cycle: {
    section_1_check: {
      meeting_date_format_valid: boolean;
      protocol_number_present: boolean;
    };
    section_3_check: {
      customer_people_count: number;
      executor_people_count: number;
      all_have_full_names: boolean;
      all_have_positions: boolean;
    };
    section_8_check: {
      decisions_count: number;
      all_have_responsible: boolean;
    };
    style_check: {
      business_style: boolean;
      no_hypothetical_phrases: boolean;
      no_example_only_data: boolean;
    };
  };

  /** Этап 4: Верификация и консолидация */
  stage_4_verification: {
    all_sections_present: boolean;
    all_responsibles_present: boolean;
    all_names_complete: boolean;
    business_style_preserved: boolean;
    identified_issues: string[];
    gap_filling_decisions: string[];
  };

  /** Этап 5: Формирование ответа */
  stage_5_output: {
    protocol: any; // Protocol schema
    generation_status: 'success' | 'partial' | 'failed';
    warnings: string[];
  };
}

// ----------------------------------------------------------------------------
// SGR для классификации намерений (classifier)
// ----------------------------------------------------------------------------
export interface SgrIntentClassification {
  /** Этап 1: Анализ контекста диалога */
  stage_1_context_analysis: {
    message_count: number;
    has_attachments: boolean;
    has_existing_document: boolean;
    conversation_stage: 'greeting' | 'information_gathering' | 'clarification' | 'finalization';
  };

  /** Этап 2: Анализ последнего сообщения */
  stage_2_message_analysis: {
    cleaned_text: string;
    keywords: string[];
    has_document_command: boolean;
    has_readiness_confirmation: boolean;
    has_clarification_request: boolean;
  };

  /** Этап 3: Routing - Выбор пути */
  stage_3_routing: {
    arguments_for_document: string[];
    arguments_for_chat: string[];
    selected_route: 'chat' | 'document';
    confidence: number;
  };

  /** Этап 4: Верификация */
  stage_4_verification: {
    context_consistent: boolean;
    no_conflicting_signals: boolean;
    final_verdict: {
      type: 'chat' | 'document';
      confidence: number;
      reasoning: string;
    };
  };
}

// ----------------------------------------------------------------------------
// SGR для общего диалога (main-agent / chat-agent)
// ----------------------------------------------------------------------------
export interface SgrDialogResponse {
  /** Этап 1: Анализ входных данных */
  stage_1_input_analysis: {
    user_request: string;
    context_stage: 'greeting' | 'information_gathering' | 'clarification' | 'finalization';
    available_data: string[];
  };

  /** Этап 2: Рассуждение и извлечение фактов */
  stage_2_reasoning: {
    facts_from_transcript: string[];
    inferences: string[];
    missing_data: string[];
  };

  /** Этап 3: Верификация */
  stage_3_verification: {
    facts_verified: boolean;
    no_hallucinations: boolean;
    business_style: boolean;
  };

  /** Этап 4: Формирование ответа */
  stage_4_output: {
    response_type: 'question' | 'confirmation' | 'summary' | 'clarification';
    content: string;
    timecode_marker?: string;
  };
}
