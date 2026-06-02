import axios from 'axios';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1';

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

export async function generateAmountFromImage(imageUrl: string): Promise<number> {
  if (!headers) return 0;

  const response = await axios.post(
    `${GROQ_API_URL}/chat/completions`,
    {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            {
              type: 'text',
              text: 'Este es un comprobante de transferencia o recarga de casino online en Argentina. Encontrá el monto total transferido en pesos. Respondé SOLO con el número, sin puntos de miles ni símbolo $. Por ejemplo: 15000. Si no podés determinar el monto, respondé 0.',
            },
          ],
        },
      ],
      max_tokens: 50,
      temperature: 0,
    },
    { headers },
  );

  const text: string = response.data?.choices?.[0]?.message?.content ?? '';
  return extractNumberFromText(text);
}

function extractNumberFromText(text: string) {
  const match = text.replace(/\./g, '').match(/\d+(?:,\d{1,2})?/);
  if (!match) {
    return 0;
  }
  return Number(match[0].replace(',', '.'));
}
