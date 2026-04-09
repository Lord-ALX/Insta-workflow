import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { GoogleGenAI, Modality } from "@google/genai";

const app = express();

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || process.env.TOKEN_API || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is missing.");
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

app.set("trust proxy", 1);
app.use(express.json({ limit: "20mb" }));

const allowedOrigins = CORS_ORIGIN.split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .flatMap((origin) => {
    if (origin.startsWith("http://") || origin.startsWith("https://")) {
      return [origin];
    }
    return [`https://${origin}`, `https://www.${origin}`];
  });

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin non autorisee"));
    }
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Trop de requetes, reessayez plus tard." }
  })
);

function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(500).json({
      error: "API_TOKEN manquant cote serveur."
    });
  }

  const authHeader = req.headers.authorization || "";
  const expected = `Bearer ${API_TOKEN}`;

  if (authHeader !== expected) {
    return res.status(401).json({
      error: "Token invalide."
    });
  }

  next();
}

function cleanDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2]
  };
}

function extractBase64FromGeminiResponse(response) {
  if (!response) return null;
  const candidates = response.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        return part.inlineData.data;
      }
    }
  }
  return null;
}

function extractTextFromGeminiResponse(response) {
  if (!response) return "";
  if (typeof response.text === "string" && response.text.trim()) {
    return response.text.trim();
  }
  const candidates = response.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    const texts = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean);
    if (texts.length) {
      return texts.join("\n").trim();
    }
  }
  return "";
}

function normalizeHashtags(text) {
  const tokens = String(text || "")
    .replace(/[,\n\r\t]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const cleaned = [];
  const seen = new Set();

  for (let token of tokens) {
    token = token.replace(/^#+/, "");
    token = token.replace(/[^\p{L}\p{N}_]/gu, "");
    if (!token) continue;

    const hashtag = `#${token}`;
    const key = hashtag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      cleaned.push(hashtag);
    }
  }

  return cleaned.join(" ");
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "insta-workflow",
    geminiConfigured: Boolean(GEMINI_API_KEY)
  });
});

app.post("/api/generate-tags", requireApiToken, async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: "GEMINI_API_KEY manquant cote serveur."
      });
    }

    const { prompt } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "Prompt manquant." });
    }

    const systemPrompt = `
Tu generes uniquement des hashtags pour un post social media.
Contraintes :
- Retourne uniquement des hashtags
- Pas de phrase d'introduction
- Pas d'explication
- 18 a 25 hashtags maximum
- Melange hashtags metier, marketing, produit, localisation et visibilite
- Pas de doublons
- Format attendu : hashtags separes par un espace
- Langue principale : francais
- Tu peux inclure quelques hashtags anglais pertinents si utile
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${systemPrompt}\n\nContexte:\n${String(prompt).trim()}`
            }
          ]
        }
      ]
    });

    const rawText = extractTextFromGeminiResponse(response);
    const tags = normalizeHashtags(rawText);

    if (!tags) {
      return res.status(500).json({ error: "Impossible de generer les hashtags." });
    }

    return res.json({ tags });
  } catch (error) {
    console.error("Erreur /api/generate-tags :", error);
    return res.status(500).json({ error: "Erreur lors de la generation des hashtags." });
  }
});

app.post("/api/generate-image", requireApiToken, async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: "GEMINI_API_KEY manquant cote serveur." });
    }

    const { productImage, logoImage, productName, promoMessage, ambiance, format } = req.body || {};

    if (!productImage || !productName || !ambiance || !format) {
      return res.status(400).json({ error: "Champs requis manquants pour la generation d'image." });
    }

    const productInline = cleanDataUrl(productImage);
    if (!productInline) {
      return res.status(400).json({ error: "Image produit invalide." });
    }

    let logoInline = null;
    if (logoImage) {
      logoInline = cleanDataUrl(logoImage);
      if (!logoInline) {
        return res.status(400).json({ error: "Logo invalide." });
      }
    }

    const ratioLabelMap = {
      "1:1": "carre 1:1",
      "9:16": "portrait 9:16",
      "16:9": "paysage 16:9"
    };

    const formatLabel = ratioLabelMap[format] || format;

    const imagePrompt = `
Cree un visuel marketing premium et realiste pour reseaux sociaux a partir de l'image produit fournie.

Contraintes globales :
- Respecter fidelement le produit fourni
- Ne pas deformer le produit
- Style visuel propre, haut de gamme, moderne
- Qualite publicitaire professionnelle
- Composition lisible et impactante
- Format final : ${formatLabel}
- Fond et ambiance : ${String(ambiance).trim()}

Produit :
- Nom : ${String(productName).trim()}

Message promotionnel :
- ${String(promoMessage || "").trim() || "Pas de texte promotionnel obligatoire"}

Texte dans le visuel :
- Si un message promotionnel est fourni, l'integrer avec elegance
- Typographie premium, lisible, moderne
- Ne pas surcharger
- Si aucun message promotionnel utile, privilegier un visuel epure

Logo :
- Si un logo est fourni, l'integrer discretement et proprement
- Ne pas deformer le logo
- Le placer comme signature de marque elegante

Objectif :
- Creer une image prete pour une publication marketing Instagram / social media
- Rendu premium, credible, vendeur, esthetique
`;

    const parts = [
      { text: imagePrompt },
      {
        inlineData: {
          mimeType: productInline.mimeType,
          data: productInline.data
        }
      }
    ];

    if (logoInline) {
      parts.push({
        inlineData: {
          mimeType: logoInline.mimeType,
          data: logoInline.data
        }
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image-preview",
      contents: [
        {
          role: "user",
          parts
        }
      ],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE]
      }
    });

    const imageBase64 = extractBase64FromGeminiResponse(response);
    if (!imageBase64) {
      return res.status(500).json({ error: "Aucune image n'a ete retournee par Gemini." });
    }

    return res.json({
      image: `data:image/png;base64,${imageBase64}`
    });
  } catch (error) {
    console.error("Erreur /api/generate-image :", error);
    return res.status(500).json({ error: "Erreur lors de la generation de l'image." });
  }
});

app.use((err, req, res, next) => {
  console.error("Erreur middleware :", err);
  return res.status(500).json({ error: err?.message || "Erreur serveur." });
});

app.listen(PORT, () => {
  console.log(`Serveur demarre sur le port ${PORT}`);
});
