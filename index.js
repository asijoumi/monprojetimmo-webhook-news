const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cheerio = require('cheerio');
const slugify = require('slugify');
const multer = require('multer');
const { customAlphabet } = require('nanoid');
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);

const upload = multer();

require('dotenv').config();

// Configuration
const config = {
  port: process.env.PORT || 3001,
  strapiUrl: process.env.STRAPI_URL,
  strapiToken: process.env.STRAPI_TOKEN,
  makeApiKey: process.env.MAKE_API_KEY,
  strapiContentType: 'news',
};

const app = express();

// Middleware pour parser le JSON (avec nettoyage des caractères de contrôle)
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    // Nettoyer les caractères de contrôle non échappés dans le JSON brut
    req.rawBody = buf.toString('utf8');
  }
}));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    // Tenter de nettoyer et re-parser le JSON
    try {
      const cleaned = req.rawBody.replace(/[\x00-\x1F\x7F]/g, (char) => {
        if (char === '\n') return '\\n';
        if (char === '\r') return '\\r';
        if (char === '\t') return '\\t';
        return '';
      });
      req.body = JSON.parse(cleaned);
      next();
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON', message: e.message });
    }
  } else {
    next(err);
  }
});
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ─────────────────────────────────────────────
// Fonctions utilitaires
// ─────────────────────────────────────────────

// Detecter le vrai type d'image depuis les magic bytes
function detectImageType(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

// Uploader un buffer image sur Strapi
async function uploadBufferToStrapi(buffer, filename, mimetype) {
  try {
    // Detecter le vrai type si le mimetype est generique
    const detected = detectImageType(buffer);
    if (detected) {
      mimetype = detected.mime;
    }

    console.log(`  Upload buffer image: ${filename} (${mimetype})`);

    const ext = detected ? detected.ext : (mimetype.split('/')[1] || 'png');
    const finalName = filename.includes('.') ? filename : `${filename}.${ext}`;

    const form = new FormData();
    form.append('files', buffer, {
      filename: finalName,
      contentType: mimetype,
    });

    const uploadResponse = await axios.post(
      `${config.strapiUrl}/api/upload`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${config.strapiToken}`,
        },
      }
    );

    console.log(`  Image uploadee: ${uploadResponse.data[0].url}`);
    return uploadResponse.data[0];
  } catch (error) {
    console.error(`  Erreur upload buffer image:`, error.message);
    return null;
  }
}

// Télécharger une image et l'uploader sur Strapi
async function downloadAndUploadImage(imageUrl, imageName) {
  try {
    console.log(`  Telechargement de l'image: ${imageUrl}`);

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const form = new FormData();
    form.append('files', Buffer.from(response.data), {
      filename: imageName,
      contentType: response.headers['content-type'],
    });

    const uploadResponse = await axios.post(
      `${config.strapiUrl}/api/upload`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${config.strapiToken}`,
        },
      }
    );

    console.log(`  Image uploadee: ${uploadResponse.data[0].url}`);
    return uploadResponse.data[0];
  } catch (error) {
    console.error(`  Erreur upload image ${imageUrl}:`, error.message);
    return null;
  }
}

// Traiter le HTML : supprimer H1/image initiale, ajouter <br> avant chaque H2
function processHtmlContent(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Supprimer le script JSON-LD si present
  $('script[type="application/ld+json"]').remove();

  // Supprimer le H1 s'il est en premier element
  const firstElement = $('body').children().first();
  if (firstElement.is('h1')) {
    firstElement.remove();

    const nextElement = $('body').children().first();
    if (nextElement.is('img')) {
      nextElement.remove();
    } else if (nextElement.is('p')) {
      const imgInP = nextElement.find('img');
      if (imgInP.length > 0 && nextElement.text().trim() === '') {
        nextElement.remove();
      }
    }
  }

  let processedHtml = $('body').html();

  // Ajouter <br> avant chaque <h2>
  processedHtml = processedHtml.replace(/<h2/g, '<br><h2');

  return processedHtml;
}

// Extraire et re-uploader les images du contenu vers Strapi
async function processImagesInContent(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const imageMap = new Map();

  const images = $('img');
  console.log(`  ${images.length} image(s) trouvee(s) dans le contenu`);

  let successCount = 0;
  let failCount = 0;
  const timestamp = Date.now();

  for (let i = 0; i < images.length; i++) {
    const img = images.eq(i);
    const src = img.attr('src');

    if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
      const urlParts = src.split('/');
      let filename = urlParts[urlParts.length - 1].split('?')[0];

      if (!filename.includes('.')) {
        filename += '.jpg';
      }

      filename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
      filename = `content_${timestamp}_${i}_${filename}`;

      const uploadedImage = await downloadAndUploadImage(src, filename);

      if (uploadedImage) {
        const newUrl = `${config.strapiUrl}${uploadedImage.url}`;
        img.attr('src', newUrl);
        imageMap.set(src, uploadedImage);
        successCount++;
      } else {
        failCount++;
        console.log(`  Image ${i + 1}/${images.length} non uploadee, URL originale conservee`);
      }
    }
  }

  console.log(`  Resultat upload images: ${successCount} reussies, ${failCount} echouees sur ${images.length} total`);

  return {
    html: $.html(),
    images: Array.from(imageMap.values()),
    stats: { total: images.length, success: successCount, failed: failCount },
  };
}

// Verifier le Bearer token
function verifyBearerToken(req, expectedToken) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  // Extraire le token apres le premier espace (tolerant aux typos comme "Baerer")
  const token = authHeader.split(' ')[1];
  return token === expectedToken;
}

// Creer un article dans Strapi (collection news)
async function createNewsInStrapi({ title, slug, processedContent, heroImageId }) {
  const strapiData = {
    data: {
      title,
      slug,
      content: processedContent,
    },
  };

  if (heroImageId) {
    strapiData.data.cover = heroImageId;
  }

  const response = await axios.post(
    `${config.strapiUrl}/api/${config.strapiContentType}`,
    strapiData,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.strapiToken}`,
      },
    }
  );

  return response.data;
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// Health check
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', message: 'Webhook news endpoint is running' });
});

// Webhook Make.com
app.post('/webhook/make', upload.any(), async (req, res) => {
  try {
    console.log('\n--- Webhook recu de Make.com ---');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    console.log(config)
    console.log(req.headers)

    if (!verifyBearerToken(req, config.makeApiKey)) {
      console.log('Token invalide');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { Title, Content } = req.body;

    if (!Title || !Content) {
      console.log('Donnees manquantes (Title et Content requis)');
      return res.status(400).json({ error: 'Missing required fields: Title and Content' });
    }

    const slug = slugify(Title + ' ' + nanoid(), {
      lower: true,
      strict: true,
      locale: 'fr',
      trim: true,
    });

    console.log(`Traitement de l'article: ${Title}`);

    // Convertir le texte brut en HTML : chaque ligne = un paragraphe + br entre chaque
    let content = Content
      .split(/\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => `<p>${l}</p>`)
      .join('<br>');

    const { html: processedContent, images } = await processImagesInContent(content);

    // Utiliser l'image envoyee par Make.com comme cover, sinon la premiere du contenu
    let heroImageId = null;
    const imageFile = req.files && req.files.find(f => f.fieldname === 'Image');
    if (imageFile) {
      console.log(`Upload de l'image cover depuis Make.com (${imageFile.size} bytes)`);
      const uploaded = await uploadBufferToStrapi(imageFile.buffer, `cover-${slug}`, imageFile.mimetype);
      if (uploaded) {
        heroImageId = uploaded.id;
      }
    } else if (images.length > 0) {
      heroImageId = images[0].id;
      console.log(`Cover extraite du contenu (ID: ${heroImageId})`);
    }

    const strapiResponse = await createNewsInStrapi({
      title: Title,
      slug,
      processedContent,
      heroImageId,
    });

    console.log(`Article cree dans Strapi (ID: ${strapiResponse.data.id})`);

    res.status(200).json({
      success: true,
      message: 'Actualite publiee avec succes',
      articleId: strapiResponse.data.id,
      imagesUploaded: images.length,
    });
  } catch (error) {
    console.error('Erreur lors du traitement du webhook:', error.message);
    if (error.response) {
      console.error("Details de l'erreur:", error.response.data);
    }
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Endpoint de test
app.post('/test', async (req, res) => {
  try {
    const testData = {
      title: 'Les taux immobiliers en baisse en 2025',
      content_html: `
        <p>Les taux immobiliers continuent leur tendance a la baisse ce trimestre.</p>
        <h2>Contexte economique</h2>
        <p>La BCE a annonce une nouvelle baisse de ses taux directeurs.</p>
        <img src="https://via.placeholder.com/800x600.jpg" alt="Graphique taux">
        <h2>Impact pour les emprunteurs</h2>
        <p>Cette baisse se repercute directement sur les taux proposes par les banques.</p>
        <h2>Nos conseils</h2>
        <p>C'est le moment ideal pour lancer votre projet immobilier.</p>
      `,
      metaDescription: 'Decouvrez les dernieres tendances des taux immobiliers et leur impact sur votre projet.',
      keywords: 'taux immobilier, emprunt, credit, 2025',
      heroImageUrl: 'https://via.placeholder.com/1200x630.jpg',
    };

    // Simuler le webhook provider1
    const response = await axios.post(
      `http://localhost:${config.port}/webhook/provider1`,
      testData,
      {
        headers: {
          Authorization: `Bearer ${config.webhookApiKey1}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json({
      message: 'Test execute',
      result: response.data,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      details: error.response?.data,
    });
  }
});

app.post('/log', upload.any(), async (req, res) => {
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Body:', req.body);
  console.log('Files', req.files)
  return res.status(200).json({
    success: true
  })
})

// Demarrage du serveur
app.listen(config.port, () => {
  console.log(`
==========================================================
  Mon Projet Immo - Webhook News -> Strapi
==========================================================
  Port:          ${config.port}
  Strapi:        ${config.strapiUrl}
  Content type:  ${config.strapiContentType}
----------------------------------------------------------
  Endpoints:
  GET  http://localhost:${config.port}/ping
  POST http://localhost:${config.port}/webhook/make
  POST http://localhost:${config.port}/test
==========================================================
  `);
});

module.exports = app;
