import type { Evidence, Interaction } from './api'

export const generalKnowledgeLabel = 'General AI knowledge — not verified against sources'
export const generalKnowledgeNotice =
  'Trellis could not verify an answer against the available sources. This explanation uses the model’s general knowledge and may contain inaccuracies.'

const withheldAnswers: Record<string, { label: string; message: string }> = {
  general_knowledge_failed: {
    label: 'AI response unavailable',
    message:
      'The AI provider could not complete a general-knowledge response. Try again in a moment or check your model connection in Settings.',
  },
  evidence_unavailable: {
    label: 'Sources needed',
    message:
      'No usable source passages were available for this question. Add a relevant source, then try again.',
  },
  insufficient_evidence: {
    label: 'More evidence needed',
    message:
      'The available passages do not cover this question well enough. Add a relevant source or ask a narrower question.',
  },
  low_grounding: {
    label: 'More support needed',
    message:
      'The draft did not pass the source checks, so no teaching answer was shown. Try again, ask a narrower question, or add a relevant source.',
  },
  invalid_citations: {
    label: 'References not verified',
    message:
      'The draft’s source references could not be verified. Try again or add a clearer source for this topic.',
  },
  evaluation_failed: {
    label: 'Answer check unavailable',
    message:
      'The answer check could not finish, so no teaching answer was shown. Try again in a moment.',
  },
}

export function responseFeedback(interaction: Interaction) {
  if (interaction.status === 'unverified')
    return { label: 'Unverified', message: interaction.content }
  if (interaction.status !== 'abstained') return { label: 'Answered', message: interaction.content }
  return (
    withheldAnswers[String(interaction.evaluation?.status)] || {
      label: 'Answer withheld',
      message:
        'There was not enough verified support to show a teaching answer. Try a narrower question or add a relevant source.',
    }
  )
}

// Stored evaluator feedback can contain passage IDs; readers use the same [n] labels as citations.
export function assessmentText(value: unknown, evidence: Evidence[], maxLength = 320) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  evidence.forEach((item, index) => {
    text = text.replaceAll(item.id, `[${index + 1}]`)
  })
  text = text.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, 'an unknown passage')
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).replace(/\s+\S*$/, '')}…`
}
