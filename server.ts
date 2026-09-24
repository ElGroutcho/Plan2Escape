import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Check if server-side Gemini API key is available
app.get('/api/health', (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  const hasServerKey = Boolean(key && key !== 'MY_GEMINI_API_KEY' && key.trim().length > 0);
  res.json({
    status: 'ok',
    hasServerKey,
    mode: hasServerKey ? 'server-managed-free' : 'client-key-required'
  });
});

// Robust JSON parser that handles markdown fences, balanced braces, and trailing text
function parseRobustJson(text: string): any {
  if (!text || typeof text !== 'string') {
    throw new Error('Réponse vide reçue du modèle IA');
  }

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch (initialErr) {
    // If there is unexpected text before or after the JSON (e.g. position 3887),
    // find the balanced outermost JSON object { ... }
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;

      for (let i = firstBrace; i < cleaned.length; i++) {
        const char = cleaned[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{') {
            depth++;
          } else if (char === '}') {
            depth--;
            if (depth === 0) {
              const slice = cleaned.slice(firstBrace, i + 1);
              try {
                return JSON.parse(slice);
              } catch (innerErr) {
                // If standard parse failed inside slice, try cleaning trailing commas
                try {
                  const sanitized = slice.replace(/,\s*([}\]])/g, '$1');
                  return JSON.parse(sanitized);
                } catch (_) {
                  break;
                }
              }
            }
          }
        }
      }

      // If balanced parser didn't resolve, fallback to lastIndexOf('}')
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace > firstBrace) {
        const candidate = cleaned.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(candidate);
        } catch (e2) {
          try {
            const sanitized = candidate.replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(sanitized);
          } catch (_) {}
        }
      }
    }

    throw initialErr;
  }
}

// Trip generation endpoint
app.post('/api/generate-trip', async (req, res) => {
  try {
    const serverKey = process.env.GEMINI_API_KEY;
    const clientKey = req.body.apiKey;
    const apiKey = (serverKey && serverKey !== 'MY_GEMINI_API_KEY' && serverKey.trim().length > 0)
      ? serverKey
      : clientKey;

    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      return res.status(400).json({
        error: {
          message: "Aucune clé d'API Gemini n'est configurée (ni sur le serveur, ni fournie par le client)."
        }
      });
    }

    const {
      queryMode = 'structured',
      naturalQuery = '',
      departureCity = 'Paris',
      destinations = 'Japon',
      durationDays = 7,
      datesText = 'Automne',
      style = 'Culture & Découverte',
      budgetEstimate = 'Équilibré',
      customPreferences = ''
    } = req.body;

    let promptText = '';

    if (queryMode === 'natural' || (naturalQuery && naturalQuery.trim().length > 0)) {
      promptText = `Tu es un expert planificateur de voyage et conseiller en logistique touristique.
L'utilisateur a exprimé son souhait de voyage sous forme libre et naturelle en français :
"${naturalQuery}"

Consignes impératives d'analyse et de planification :
1. Analyse minutieusement la demande libre pour extraire automatiquement :
   - La ville ou région de départ (si non mentionnée, déduis la plus logique ou Paris par défaut).
   - La ou les destinations (pays, région, département, ville).
   - Le nombre de jours précis de l'itinéraire (si l'utilisateur indique par exemple 15 jours, la durée est très exactement de 15 jours).
   - La saison, le mois ou la période de l'année (ex: décembre, été, vacances scolaires, etc.).
   - Le style de voyage, l'ambiance et les préférences sous-jacentes.

2. EXIGENCE ABSOLUE D'EXHAUSTIVITÉ (NE JAMAIS TRONQUER L'ITINÉRAIRE) :
   - L'array "itinerary" DOIT OBLIGATOIREMENT comporter TOUS LES JOURS du séjour, du Jour 1 jusqu'au Jour N (par exemple, pour un voyage de 15 jours, l'array "itinerary" DOIT CONTENIR TRÈS EXACTEMENT 15 ÉLÉMENTS DISTINCTS, du jour 1 au jour 15).
   - IL EST STRICTEMENT INTERDIT de ne générer que 2 ou 3 jours d'échantillons ou de résumer. Chaque jour de 1 à N doit avoir son propre objet complet dans le tableau.
   - Pour garantir que l'ensemble des 15 journées soit généré sans être tronqué par la limite de tokens, reste concis et percutant dans les textes de chaque moment : 1-2 phrases pour le matin, 1 phrase pour le déjeuner, 1-2 phrases pour l'après-midi, 1 phrase pour le soir.

3. RÈGLE IMPÉRATIVE DU DERNIER JOUR (JOUR OÙ L'ON DOIT ÊTRE RENTRÉS AU DOMICILE) :
   - Le TOUT DERNIER JOUR (Jour N) DOIT IMPÉRATIVEMENT être le jour du RETOUR et de la RENTRÉE CHEZ SOI au domicile.
   - L'intitulé de ce dernier jour doit être explicite (ex: "Jour N : Retour à [Ville de départ] / Rentrée au domicile").
   - Ce jour est dédié au check-out, derniers achats/souvenirs, transfert aéroport/gare, vol/trajet retour, et arrivée chez soi le soir. Les voyageurs doivent être rentrés chez eux à la fin de cette journée.

4. RÈGLE SUR LES VOLS LONG-COURRIER (MÊMES AÉROPORTS ALLER ET RETOUR) :
   - Pour les voyages long-courrier (intercontinentaux / vols internationaux lointains), considère impérativement que l'aller et le retour internationaux se font à partir des MÊMES aéroports principaux :
     * Même aéroport de départ et d'arrivée dans la ville d'origine (ex: départ CDG à l'aller, arrivée CDG au retour).
     * Même aéroport hub international dans le pays de destination (ex: arrivée à Tokyo-Haneda/Narita à l'aller, et départ du vol long-courrier retour également depuis Tokyo-Haneda/Narita).
     * Si le séjour s'achève dans une autre ville intérieure, prévois la liaison intérieure intermédiaire (train rapide ou vol intérieur) pour rejoindre ce même aéroport hub principal.

5. DÉCALAGE HORAIRE CONCRÉTISÉ ("timeZoneDifference") :
   - Formule le décalage horaire de manière très concrète avec un exemple parlant comparant l'heure de départ et l'heure sur place.
   - Exemple obligatoire : "+6h (lorsqu'il est 12h00 à Toulouse, il est 18h00 à Tokyo)" ou "-5h (à 12h00 à Paris, il est 07h00 à New York)" ou "0h (même fuseau horaire qu'à [Ville départ])".

6. DÉTAIL DU BUDGET ("budgetBreakdown") :
   - Fournis une estimation ventilée réaliste par poste de dépense pour permettre d'afficher le détail du budget : transports/vols, hébergement, repas, activités et visites, transports locaux.

7. PRÉCONISATION HORAIRE DES VOLS & TRAJETS :
   - ALLER : Préconise impérativement un DÉPART LE MATIN (créneau matinal recommandé ex: 07h00-09h30) pour rentabiliser le premier jour.
   - RETOUR : Préconise impérativement un RETOUR LE SOIR (créneau 19h00-22h30) depuis la dernière étape pour profiter au maximum du dernier jour.

8. RÈGLE TERMINOLOGIQUE STRICTE : N'utilise le mot "vol" que lorsqu'il s'agit explicitement d'un déplacement en avion. Pour tout trajet terrestre (voiture, train, TER, TGV, bus, road trip), utilise exclusivement le mot "trajet".

9. Pour chaque jour, fournis des coordonnées GPS exactes et réalistes (latitude et longitude en décimales) correspondant au lieu ou monument principal visité.

10. VOYAGE MULTIDESTINATION (RÉPARTITION DU TEMPS PAR DESTINATION) :
    - Si le voyage comporte plusieurs villes, étapes ou pays (ex: Tokyo, Kyoto, Osaka ou Rome, Florence, Venise), fournis impérativement le tableau "destinationBreakdown" indiquant pour chaque étape distincte le nom de la destination, le nombre de jours alloués ("daysCount"), le pourcentage relatif ("percentage"), l'intervalle de jours ("dayRange" ex: "J1 - J4") et les 2-3 attractions phares ("highlights").

Tu DOIS impérativement renvoyer UNIQUEMENT un objet JSON valide correspondant EXACTEMENT au schéma suivant, sans texte introductif, ni markdown :
{
  "title": "Titre inspirant et personnalisé du voyage",
  "departureCity": "Ville de départ extraite",
  "destinations": ["Destination(s) extraite(s)"],
  "datesText": "Période détectée",
  "durationDays": 15,
  "style": "Style détecté ou adapté",
  "budgetEstimate": "Estimation globale de budget (ex: 1400€ - 1700€ / pers)",
  "budgetBreakdown": {
    "totalPerPerson": "1400€ - 1700€ / pers",
    "flights": "650€ - 850€ (Vols long-courrier aller-retour depuis les mêmes aéroports)",
    "accommodation": "450€ - 600€ (Hébergements 3*, ~35€-45€/nuit/pers)",
    "food": "300€ - 400€ (Repas et spécialités locales, ~25€/jour)",
    "activities": "150€ - 200€ (Entrées monuments, musées et pass)",
    "localTransport": "100€ - 150€ (Pass train / métro / transferts)",
    "tipsAndAdvice": "Réserver les billets 3 mois à l'avance et privilégier les cartes de transport locales."
  },
  "destinationBreakdown": [
    {
      "name": "Étape 1 (ex: Tokyo)",
      "daysCount": 4,
      "percentage": 40,
      "dayRange": "J1 - J4",
      "highlights": "Shibuya, Senso-ji, Akihabara"
    },
    {
      "name": "Étape 2 (ex: Kyoto)",
      "daysCount": 3,
      "percentage": 30,
      "dayRange": "J5 - J7",
      "highlights": "Gion, Fushimi Inari, Kinkaku-ji"
    }
  ],
  "climateAndBestTime": "Recommandations météorologiques détaillées et vêtements recommandés pour cette période",
  "timeZoneDifference": "+6h (à 12h00 à Ville Départ, il est 18h00 à Destination)",
  "flightDetails": {
    "transportType": "avion ou voiture ou train ou mixte",
    "outbound": "Détails trajet/vol aller (avec créneau DÉPART LE MATIN préconisé de Ville Départ vers 1ère étape)",
    "inbound": "Détails trajet/vol retour (avec créneau RETOUR LE SOIR préconisé pour rentrer au domicile)",
    "lastCity": "Nom de la toute dernière étape du voyage",
    "layovers": "Direct ou X escale(s) / Trajet direct",
    "totalDuration": "Durée estimée du trajet/vol",
    "scheduleTip": "Départ le matin et retour le soir préconisés pour profiter à 100% de votre temps sur place.",
    "intermediateConnections": [
      {
        "from": "Ville A",
        "to": "Ville B",
        "type": "Vol intérieur / Train TGV / Route",
        "details": "Liaison directe avec horaire recommandé en début de journée",
        "duration": "~1h30"
      }
    ]
  },
  "localEvents": [
    "Conseil pratique ou particularité locale 1",
    "Conseil transport, itinéraire ou réservation 2",
    "Spécialité culinaire ou activité saisonnière 3"
  ],
  "itinerary": [
    {
      "day": 1,
      "title": "Titre évocateur de la journée",
      "description": "Synthèse de la journée",
      "morning": "Programme du matin (1-2 phrases)",
      "lunch": "Pause déjeuner et spécialité locale (1 phrase)",
      "afternoon": "Programme de l'après-midi (1-2 phrases)",
      "evening": "Soirée et dîner (1 phrase)",
      "locationName": "Nom précis du lieu principal",
      "coordinates": { "lat": 44.4447, "lng": 1.4326 }
    }
  ]
}`;
    } else {
      promptText = `Tu es un expert planificateur de voyage international et conseiller en logistique touristique.
L'utilisateur souhaite planifier un voyage complet selon les paramètres suivants :
- Ville de départ : "${departureCity}"
- Destination(s) : "${destinations}"
- Durée en jours : ${durationDays}
- Période / dates : "${datesText}"
- Style de voyage : "${style}"
- Budget estimé : "${budgetEstimate}"
${customPreferences ? `- Souhaits particuliers & rythme : "${customPreferences}"` : ''}

Consignes impératives de planification :
1. EXIGENCE ABSOLUE D'EXHAUSTIVITÉ (GÉNÉRATION COMPLÈTE DES ${durationDays} JOURS) :
   - L'array "itinerary" DOIT OBLIGATOIREMENT comporter TRÈS EXACTEMENT ${durationDays} OBJETS (un pour chaque jour, du Jour 1 jusqu'au Jour ${durationDays} sans aucune omission ni coupure).
   - IL EST STRICTEMENT INTERDIT de ne générer que 2 ou 3 jours d'exemple ! Les ${durationDays} jours doivent tous être présents.
   - Pour que la réponse reste dans les limites de tokens, rédige des descriptions directes et rythmées (1 à 2 phrases par créneau : morning, lunch, afternoon, evening).

2. RÈGLE IMPÉRATIVE DU DERNIER JOUR (JOUR OÙ L'ON DOIT ÊTRE RENTRÉS AU DOMICILE) :
   - Le TOUT DERNIER JOUR (Jour ${durationDays}) DOIT IMPÉRATIVEMENT être le jour du RETOUR et de la RENTRÉE AU DOMICILE à ${departureCity}.
   - Intitule expressément le Jour ${durationDays} : "Jour ${durationDays} : Retour à ${departureCity} et fin du voyage".
   - Le déroulé du Jour ${durationDays} est consacré aux derniers préparatifs, transfert aéroport/gare, voyage de retour et arrivée chez soi le soir.

3. RÈGLE SUR LES VOLS LONG-COURRIER (MÊMES AÉROPORTS ALLER ET RETOUR) :
   - Pour les vols long-courrier, l'aller et le retour internationaux se font obligatoirement depuis les MÊMES aéroports principaux :
     * Même aéroport de départ et d'arrivée dans la ville d'origine ${departureCity}.
     * Même aéroport hub international dans le pays visité (ex: Haneda/Narita pour Tokyo).
     * Les liaisons intermédiaires intérieures assurent le retour vers ce hub le dernier jour ou la veille si nécessaire.

4. DÉCALAGE HORAIRE CONCRÉTISÉ ("timeZoneDifference") :
   - Formule le décalage horaire sous forme concrète avec un exemple parlant.
   - Exemple obligatoire : "+6h (à 12h00 à ${departureCity}, il est 18h00 à ${destinations})" ou "-5h (à 12h00 à ${departureCity}, il est 07h00 à ${destinations})" ou "0h (même fuseau horaire)".

5. DÉTAIL DU BUDGET ("budgetBreakdown") :
   - Fournis un détail réaliste et précis du budget poste par poste : vols/transports, hébergement, repas, activités et transports locaux.

6. PRÉCONISATION HORAIRE DES VOLS & TRAJETS :
   - ALLER : Préconise impérativement un DÉPART LE MATIN (ex: entre 07h00 et 09h30).
   - RETOUR : Préconise impérativement un RETOUR LE SOIR (ex: entre 19h00 et 22h30).

7. RÈGLE TERMINOLOGIQUE STRICTE : N'utilise le mot "vol" que lorsqu'il s'agit explicitement d'un déplacement en avion. Pour les trajets terrestres (voiture, train, bus, road trip), utilise exclusivement le mot "trajet".

8. Pour chaque jour, fournis des coordonnées GPS exactes et réalistes (latitude et longitude en décimales).

9. VOYAGE MULTIDESTINATION (RÉPARTITION DU TEMPS PAR DESTINATION) :
   - Si le voyage comporte plusieurs villes, étapes ou pays (ex: "${destinations}"), fournis impérativement le tableau "destinationBreakdown" avec pour chaque étape le nom, le nombre de jours ("daysCount"), le pourcentage relatif ("percentage"), l'intervalle ("dayRange" ex: "J1 - J4") et les 2-3 attractions clés ("highlights").

Tu DOIS impérativement renvoyer UNIQUEMENT un objet JSON valide correspondant EXACTEMENT au schéma suivant, sans texte introductif, ni markdown :
{
  "title": "Titre inspirant et personnalisé du voyage",
  "departureCity": "${departureCity}",
  "destinations": ["${destinations}"],
  "datesText": "${datesText}",
  "durationDays": ${durationDays},
  "style": "${style}",
  "budgetEstimate": "${budgetEstimate}",
  "budgetBreakdown": {
    "totalPerPerson": "${budgetEstimate} / pers",
    "flights": "Estimation vols aller-retour depuis les mêmes aéroports",
    "accommodation": "Estimation hébergements pour ${durationDays} jours",
    "food": "Estimation repas et restauration",
    "activities": "Estimation entrées et activités",
    "localTransport": "Estimation transports sur place",
    "tipsAndAdvice": "Conseils pratiques pour maîtriser le budget"
  },
  "destinationBreakdown": [
    {
      "name": "Étape 1 (ex: Première ville)",
      "daysCount": 3,
      "percentage": 40,
      "dayRange": "J1 - J3",
      "highlights": "Lieu A, Lieu B"
    }
  ],
  "climateAndBestTime": "Recommandations météorologiques détaillées et vêtements recommandés pour cette période",
  "timeZoneDifference": "+Xh (à 12h00 à ${departureCity}, il est XXh à ${destinations})",
  "flightDetails": {
    "transportType": "avion ou voiture ou train ou mixte",
    "outbound": "Détails trajet/vol aller avec départ le matin conseillé depuis ${departureCity}",
    "inbound": "Détails trajet/vol retour avec retour le soir conseillé pour rentrer à ${departureCity}",
    "lastCity": "Nom de la dernière ville visitée",
    "layovers": "Direct ou X escale(s) / Trajet direct",
    "totalDuration": "~Xh de trajet/vol",
    "scheduleTip": "Départ le matin et retour le soir préconisés pour optimiser votre séjour.",
    "intermediateConnections": [
      {
        "segment": "Liaison intérieure Étape A -> Étape B",
        "from": "Ville A",
        "to": "Ville B",
        "type": "Vol intérieur / Train / Route",
        "duration": "~2h",
        "recommendedTime": "Départ matin conseillé",
        "details": "Détails de la liaison inter-étapes"
      }
    ]
  },
  "localEvents": [
    "Conseil pratique ou coutume locale 1",
    "Conseil transport ou billet à réserver à l'avance 2",
    "Recommandation culinaire ou événement saisonnier 3"
  ],
  "itinerary": [
    {
      "day": 1,
      "title": "Titre évocateur de la journée",
      "description": "Synthèse de la journée",
      "morning": "Programme du matin (1-2 phrases)",
      "lunch": "Pause déjeuner et spécialité suggérée (1 phrase)",
      "afternoon": "Visites de l'après-midi (1-2 phrases)",
      "evening": "Soirée et dîner (1 phrase)",
      "locationName": "Nom précis du lieu ou quartier principal",
      "coordinates": { "lat": 48.8566, "lng": 2.3522 }
    }
  ]
}`;
    }

    const ai = new GoogleGenAI({ apiKey });
    // Prefer gemini-3.8-flash, with gemini-3.1-flash-lite as high-capacity fast fallback
    const candidateModels = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
    let lastError: any = null;
    let tripData: any = null;

    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: promptText,
          config: {
            responseMimeType: 'application/json',
            maxOutputTokens: 8192
          }
        });

        const rawText = response.text || '';
        tripData = parseRobustJson(rawText);
        if (tripData && tripData.itinerary && Array.isArray(tripData.itinerary) && tripData.itinerary.length > 0) {
          const expectedDays = Number(durationDays) || 0;
          if (queryMode === 'structured' && expectedDays > 2 && tripData.itinerary.length < Math.min(expectedDays, 3)) {
            console.warn(`Model ${modelName} returned only ${tripData.itinerary.length} days out of ${expectedDays}, trying next model...`);
            continue;
          }
          break;
        }
      } catch (err: any) {
        console.warn(`Model ${modelName} failed, trying fallback:`, err?.message || err);
        lastError = err;
      }
    }

    if (!tripData) {
      const errMsg = lastError?.message || '';
      const isQuota = lastError?.status === 'RESOURCE_EXHAUSTED' || errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('Quota exceeded');
      if (isQuota) {
        return res.status(429).json({
          error: {
            message: "Le quota de requêtes gratuites est momentanément sollicité. Veuillez patienter environ 30 secondes et cliquer sur 'Réessayer', ou ajouter votre propre clé API Gemini gratuite."
          }
        });
      }
      throw lastError || new Error("Impossible de générer l'itinéraire. Veuillez réessayer dans quelques instants.");
    }

    return res.json(tripData);

  } catch (error: any) {
    console.error('Server generation error:', error);
    return res.status(500).json({
      error: {
        message: error.message || "Erreur interne lors de la génération de l'itinéraire."
      }
    });
  }
});

// Endpoint pour adapter/affiner partiellement un itinéraire existant
app.post('/api/refine-trip', async (req, res) => {
  try {
    const { currentTrip, instruction, apiKey: userProvidedKey } = req.body;

    if (!currentTrip || !instruction || !instruction.trim()) {
      return res.status(400).json({
        error: { message: "Données du voyage et instruction d'adaptation requises." }
      });
    }

    const apiKey = userProvidedKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: { message: "Clé API non disponible pour adapter le voyage." }
      });
    }

    const promptText = `Tu es un expert planificateur de voyage et conseiller logistique.
Voici l'itinéraire actuel d'un voyage complet sous forme d'objet JSON :
${JSON.stringify(currentTrip, null, 2)}

L'utilisateur souhaite ajuster ou adapter cet itinéraire avec la consigne spécifique suivante :
"${instruction.trim()}"

CONSIGNES STRICTES D'ADAPTATION CIBLÉE :
1. NE RÉGÉNÈRE OU NE MODIFIE QUE LES PARTIES DIRECTEMENT CONCERNÉES (par exemple le jour mentionné, le monument, la ville, l'activité ou le repas ciblé).
2. Conserve rigoureusement et intacts tous les autres jours, les informations générales non impactées, les dates et la structure globale.
3. Si un monument, une ville ou un lieu est ajouté ou modifié, mets à jour les coordonnées GPS du lieu ("coordinates": { "lat": ..., "lng": ... }) et le "locationName" correspondant pour ce jour.
4. Si l'utilisateur demande d'ajouter ou modifier un repas (déjeuner, dîner gastronomique, pause midi), adapte précisément le champ "lunch" ou "evening" du jour visé.
5. Si l'utilisateur demande une activité du matin ou de l'après-midi, adapte précisément le champ "morning" ou "afternoon".
6. Règle terminologique : mot "vol" uniquement pour avion, mot "trajet" pour voiture/train.
7. Maintiens les préconisations horaires (départ matin, retour soir).
8. Renvoyer UNIQUEMENT le JSON complet actualisé correspondant fidèlement au même schéma, sans texte d'introduction ni markdown.`;

    const ai = new GoogleGenAI({ apiKey });
    const candidateModels = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
    let lastError: any = null;
    let updatedTripData: any = null;

    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: promptText,
          config: {
            responseMimeType: 'application/json',
            maxOutputTokens: 8192
          }
        });

        const rawText = response.text || '';
        updatedTripData = parseRobustJson(rawText);
        if (updatedTripData && updatedTripData.itinerary && Array.isArray(updatedTripData.itinerary)) {
          break;
        }
      } catch (err: any) {
        console.warn(`Refine model ${modelName} failed, trying fallback:`, err?.message || err);
        lastError = err;
      }
    }

    if (!updatedTripData) {
      const errMsg = lastError?.message || '';
      const isQuota = lastError?.status === 'RESOURCE_EXHAUSTED' || errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('Quota exceeded');
      if (isQuota) {
        return res.status(429).json({
          error: {
            message: "Le quota de requêtes gratuites est momentanément sollicité. Veuillez patienter environ 30 secondes et réessayer."
          }
        });
      }
      throw lastError || new Error("Impossible d'adapter l'itinéraire. Veuillez réessayer.");
    }

    return res.json(updatedTripData);

  } catch (error: any) {
    console.error('Server refine error:', error);
    return res.status(500).json({
      error: {
        message: error.message || "Erreur interne lors de l'adaptation de l'itinéraire."
      }
    });
  }
});

// Vite middleware in dev or static serving in production
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.resolve(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Optitrip full-stack running on http://localhost:${PORT}`);
});
