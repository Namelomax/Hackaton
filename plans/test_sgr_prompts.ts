import { SGR_MAIN_AGENT_PROMPT } from './sgr_main_agent_prompt';
import { SGR_DOCUMENT_AGENT_PROMPT } from './sgr_document_agent_prompt';
import { SGR_CLASSIFIER_PROMPT } from './sgr_classifier_prompt';

/**
 * Test file demonstrating the SGR-based prompts for protocol generation
 */

// Sample transcript for testing
const SAMPLE_TRANSCRIPT = `
Meeting between Acme Corp and Tech Solutions Ltd.
Attendees: 
- Ivanov Petr Dmitrievich, Head of IT Department (Acme Corp)
- Sidorov Alexey Borisovich, Project Manager (Tech Solutions)
- Petrova Elena Sergeevna, Business Analyst (Acme Corp)

Date: 15.03.2026
Topic: Requirements for new CRM system

The meeting discussed requirements for a new CRM system. Key points:
- System should handle 10,000+ customer records
- Integration with existing accounting software needed
- Mobile app required for field sales staff
- Security compliance with GDPR standards

Decisions made:
- Tech Solutions to provide technical specification by March 25
- Budget approved up to 5 million rubles
- Implementation timeline: 6 months

Open questions:
- Data migration approach from legacy system
- Training schedule for end users
`;

// Sample conversation history
const SAMPLE_CONVERSATION_HISTORY = [
  {
    role: "user",
    content: "Hello, I'd like to create a protocol for our meeting."
  },
  {
    role: "assistant", 
    content: "Sure, please provide the meeting transcript or details."
  },
  {
    role: "user",
    content: SAMPLE_TRANSCRIPT
  }
];

console.log("=== SGR-ENHANCED PROMPTS TEST ===\n");

console.log("MAIN AGENT PROMPT:");
console.log(SGR_MAIN_AGENT_PROMPT);
console.log("\n" + "=".repeat(50) + "\n");

console.log("DOCUMENT AGENT PROMPT:");
console.log(SGR_DOCUMENT_AGENT_PROMPT);
console.log("\n" + "=".repeat(50) + "\n");

console.log("CLASSIFIER PROMPT:");
console.log(SGR_CLASSIFIER_PROMPT);
console.log("\n" + "=".repeat(50) + "\n");

console.log("SAMPLE TRANSCRIPT ANALYSIS:");
console.log("Transcript length:", SAMPLE_TRANSCRIPT.length, "characters");
console.log("Conversation history:", SAMPLE_CONVERSATION_HISTORY.length, "messages");

console.log("\nThe SGR prompts would guide the AI through:");
console.log("1. Systematic analysis of the transcript");
console.log("2. Mapping information to the 10-section protocol schema");
console.log("3. Identifying gaps in information");
console.log("4. Engaging in targeted dialogue to fill gaps");
console.log("5. Generating a complete, structured protocol");

console.log("\nKey improvements:");
console.log("- Explicit schema guidance for better structure");
console.log("- Thinking steps for improved reasoning");
console.log("- Context segmentation for large inputs");
console.log("- Validation loops to ensure completeness");