const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
const DEFAULT_MODEL = 'gemini-1.5-flash';

async function generateAIResponse(prompt, systemInstruction = '', modelName = DEFAULT_MODEL) {
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        systemInstruction: systemInstruction || 'أنت مساعد ذكي لإدارة وتنسيق بورصة المنظفات ومساعدة أصحاب المحلات.',
        temperature: 0.7,
      }
    });

    if (!response || !response.text) {
      throw new Error('Received empty response from Gemini API.');
    }

    return response.text();
  } catch (error) {
    console.error('[AI Error]: Failed to generate content from Gemini API:', error.message);
    throw error;
  }
}

async function parseMerchantData(messageText) {
  const systemPrompt = `استخرج بيانات التاجر أو المنتجات من النص التالي بدقة وأرجعها بصيغة JSON تحتوي على الحقول المناسبة (اسم المحل، السلع، الأسعار، الملاحظات). إذا لم تجد بيانات واضحة أرجع كائن فارغ.`;
  return await generateAIResponse(messageText, systemPrompt);
}

// إضافة الدالة createAI لتتوافق مع ما يستدعيه index.js
function createAI() {
  return {
    generateAIResponse,
    parseMerchantData,
    ai
  };
}

module.exports = {
  createAI,
  generateAIResponse,
  parseMerchantData
};
