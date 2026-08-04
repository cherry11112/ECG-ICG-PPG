
// /api/tts.js - Google Cloud Text-to-Speech with OAuth2 service account
import jwt from 'jsonwebtoken';

// Cache for OAuth2 access tokens (key: service account email, value: {token, expires})
const tokenCache = new Map();

async function getAccessToken() {
  try {
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    
    if (!serviceAccountJson) {
      console.error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');
      return null;
    }

    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountJson);
    } catch (e) {
      console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
      return null;
    }

    const email = serviceAccount.client_email;
    const privateKey = serviceAccount.private_key;
    const projectId = serviceAccount.project_id;

    if (!email || !privateKey || !projectId) {
      console.error('Service account missing required fields (client_email, private_key, project_id)');
      return null;
    }

    // Check cache
    const cached = tokenCache.get(email);
    if (cached && cached.expires > Date.now()) {
      console.log('Using cached OAuth2 token');
      return cached.token;
    }

    // Create JWT for service account
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };

    const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

    // Exchange JWT for access token
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: token
      })
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error('Failed to get access token:', errText);
      return null;
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in || 3600;

    // Cache the token
    tokenCache.set(email, {
      token: accessToken,
      expires: Date.now() + (expiresIn * 1000) - 60000 // Refresh 1 min before expiry
    });

    console.log('Got new OAuth2 access token');
    return accessToken;
  } catch (err) {
    console.error('Error getting access token:', err.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, voice = 'en-US-Neural2-H', format = 'MP3' } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Missing text' });
    }

    console.log('TTS Request:', { 
      text: text.substring(0, 50),
      voice
    });

    // Get OAuth2 access token from service account
    const accessToken = await getAccessToken();
    
    if (!accessToken) {
      console.error('Could not get OAuth2 access token - falling back to browser TTS');
      return res.status(503).json({ 
        error: 'TTS service unavailable',
        message: 'Server TTS not configured. Using browser TTS as fallback.',
        useBrowserTTS: true,
        details: 'Ensure GOOGLE_SERVICE_ACCOUNT_JSON is set correctly in environment'
      });
    }

    // Call Google Cloud Text-to-Speech REST API with OAuth2 token
    const apiUrl = 'https://texttospeech.googleapis.com/v1/text:synthesize';

    const apiResp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: 'en-US',
          name: voice
        },
        audioConfig: {
          audioEncoding: format === 'MP3' ? 'MP3' : 'LINEAR16',
          pitch: 1,
          speakingRate: 1.0
        }
      })
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('Google TTS API Error:', {
        status: apiResp.status,
        statusText: apiResp.statusText,
        body: errText
      });
      
      if (apiResp.status === 401) {
        // Clear cache on auth error
        tokenCache.clear();
        return res.status(503).json({ 
          error: 'TTS authentication failed. Using browser TTS fallback.',
          useBrowserTTS: true,
          details: 'Check GOOGLE_SERVICE_ACCOUNT_JSON credentials'
        });
      }
      
      if (apiResp.status === 403) {
        return res.status(503).json({ 
          error: 'TTS API not enabled or quota exceeded. Using browser TTS fallback.',
          useBrowserTTS: true,
          details: 'Enable Cloud Text-to-Speech API in Google Cloud Console'
        });
      }
      
      return res.status(503).json({ 
        error: `TTS request failed (${apiResp.status}). Using browser TTS fallback.`,
        useBrowserTTS: true
      });
    }

    const data = await apiResp.json();
    
    if (!data.audioContent) {
      console.error('No audio in response:', JSON.stringify(data));
      return res.status(503).json({ 
        error: 'No audio returned from Google TTS. Using browser TTS fallback.',
        useBrowserTTS: true
      });
    }

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(data.audioContent, 'base64');

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', audioBuffer.length);
    res.status(200).end(audioBuffer);

  } catch (err) {
    console.error('TTS Error:', err);
    res.status(500).json({ 
      error: err.message || 'Text-to-speech service error',
      useBrowserTTS: true
    });
  }
}



