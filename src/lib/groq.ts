import axios from 'axios';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.cloud/v1';

const headers = GROQ_API_KEY
  ? { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
  : null;

export async function generateBotResponse(systemPrompt: string, userMessage: string) {
  if (!headers) {
    // Fallback simple response when GROQ is not configured
    return `Hola! Gracias por tu mensaje: "${userMessage}". En breve un operador te responde.`;
  }

  const response = await axios.post(
    `${GROQ_API_URL}/completions`,
    {
      model: 'llama-3.3-70b-versatile',
      prompt: `${systemPrompt}\nUsuario: ${userMessage}\nAsistente:`,
      max_tokens: 250,
      temperature: 0.7,
    },
    { headers }
  );

  return response.data?.choices?.[0]?.text?.trim() ?? 'Perdón, estoy procesando tu consulta.';
}

export async function generateAmountFromImage(imageUrl: string) {
  if (!headers) {
    // If GROQ not configured, return 0 so comprobantes can still be saved
    return 0;
  }

  const response = await axios.post(
    `${GROQ_API_URL}/vision`,
    {
      model: 'llama-3.3-70b-versatile',
      image_url: imageUrl,
      task: 'document_text',
      prompt: 'Detectá el monto o número relevante del comprobante en pesos. Respondé solo el número. Si no hay monto, respondé 0.',
    },
    { headers }
  );

  const text = response.data?.output?.[0]?.content ?? '';
  const monto = extractNumberFromText(text);
  return monto;
}

function extractNumberFromText(text: string) {
  const match = text.replace(/\./g, '').match(/\d+(?:,\d{1,2})?/);
  if (!match) {
    return 0;
  }
  return Number(match[0].replace(',', '.'));
}
