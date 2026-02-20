'use client';

import { type DocumentReview, type ReviewIssue } from '@/app/api/chat/agents/review-agent';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, X, Send } from 'lucide-react';
import { useState } from 'react';

type DocumentReviewPanelProps = {
  review: DocumentReview;
  onClose: () => void;
  onSendReview?: (text: string) => void;
};

function getIssueBg(level: ReviewIssue['level']): string {
  switch (level) {
    case 'error':
      return 'bg-red-50 border-red-200';
    case 'warning':
      return 'bg-yellow-50 border-yellow-200';
    case 'info':
      return 'bg-blue-50 border-blue-200';
  }
}

function getIssueIcon(level: ReviewIssue['level']) {
  switch (level) {
    case 'error':
      return <AlertCircle className="size-5 text-red-600 flex-shrink-0" />;
    case 'warning':
      return <AlertTriangle className="size-5 text-yellow-600 flex-shrink-0" />;
    case 'info':
      return <Info className="size-5 text-blue-600 flex-shrink-0" />;
  }
}

export const DocumentReviewPanel = ({ review, onClose, onSendReview }: DocumentReviewPanelProps) => {
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);

  const errorCount = review.issues.filter((i) => i.level === 'error').length;
  const warningCount = review.issues.filter((i) => i.level === 'warning').length;

  const handleSendReview = () => {
    // Gather all issues with their suggestions
    const issuesText = review.issues
      .map((issue, idx) => {
        let text = `${idx + 1}. **${issue.section}**: ${issue.issue}`;
        if (issue.suggestion) {
          text += `\n   Предложение: ${issue.suggestion}`;
        }
        return text;
      })
      .join('\n\n');

    const fullText = `Выявлены замечания по документу, которые нужно рассмотреть и исправить:\n\n${issuesText}`;

    // Send to chat input
    if (onSendReview) {
      onSendReview(fullText);
    }

    // Close the panel
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            {review.isValid ? (
              <CheckCircle2 className="size-6 text-green-600" />
            ) : (
              <AlertCircle className="size-6 text-red-600" />
            )}
            <div>
              <h2 className="font-semibold text-lg">Проверка документа</h2>
              <p className="text-sm text-muted-foreground">
                Качество: {review.overallQuality}/100
                {errorCount > 0 && <span className="ml-2 text-red-600">{errorCount} ошибок</span>}
                {warningCount > 0 && <span className="ml-2 text-yellow-600">{warningCount} предупреждений</span>}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Summary */}
        <div className="px-4 py-3 bg-gray-50 border-b">
          <p className="text-sm text-foreground">{review.summary}</p>
        </div>

        {/* Issues List */}
        <div className="flex-1 overflow-y-auto">
          {review.issues.length === 0 ? (
            <div className="p-6 text-center">
              <CheckCircle2 className="size-12 text-green-600 mx-auto mb-2" />
              <p className="text-foreground font-medium">Ошибок не найдено!</p>
              <p className="text-sm text-muted-foreground mt-1">Документ готов к использованию</p>
            </div>
          ) : (
            <div className="space-y-2 p-4">
              {review.issues.map((issue, idx) => (
                <div
                  key={idx}
                  className={`border rounded-lg p-3 cursor-pointer transition ${getIssueBg(issue.level)}`}
                  onClick={() => setExpandedIssue(expandedIssue === idx ? null : idx)}
                >
                  <div className="flex items-start gap-3">
                    {getIssueIcon(issue.level)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-sm truncate">
                            {issue.section}
                          </p>
                          <p className="text-sm mt-1">{issue.issue}</p>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded-full font-medium flex-shrink-0 ${
                          issue.level === 'error' ? 'bg-red-100 text-red-700' :
                          issue.level === 'warning' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-blue-100 text-blue-700'
                        }`}>
                          {issue.level === 'error' ? 'Ошибка' : issue.level === 'warning' ? 'Предупреждение' : 'Замечание'}
                        </span>
                      </div>
                      {expandedIssue === idx && issue.suggestion && (
                        <div className="mt-2 pt-2 border-t text-sm">
                          <p className="text-xs font-medium text-muted-foreground">Предложение:</p>
                          <p className="mt-1">{issue.suggestion}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex justify-between gap-2">
          <Button variant="outline" onClick={onClose}>
            Закрыть
          </Button>
          {review.issues.length > 0 && onSendReview && (
            <Button
              onClick={handleSendReview}
              className="inline-flex items-center gap-2"
            >
              <Send className="size-4" />
              Отправить в чат
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
