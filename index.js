const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cheerio = require('cheerio');
const slugify = require('slugify');
const { customAlphabet } = require('nanoid');
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);

require('dotenv').config();

// Configuration
const config = {
  port: process.env.PORT || 3001,
  strapiUrl: process.env.STRAPI_URL,
  strapiToken: process.env.STRAPI_TOKEN,
  webhookApiKey1: process.env.WEBHOOK_API_KEY_1,
  webhookApiKey2: process.env.WEBHOOK_API_KEY_2,
  strapiContentType: 'news',
};

const app = express();

// Middleware pour parser le JSON
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ─────────────────────────────────────────────
// Fonctions utilitaires
// ─────────────────────────────────────────────

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
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  return authHeader.substring(7) === expectedToken;
}

// Creer un article dans Strapi (collection news)
async function createNewsInStrapi({ title, slug, processedContent, metaDescription, keywords, heroImageId }) {
  const strapiData = {
    data: {
      title,
      slug,
      content: processedContent,
      seo: {
        metaTitle: title.substring(0, 60),
        metaDescription: metaDescription || '',
        keywords: keywords || '',
      },
    },
  };

  if (heroImageId) {
    strapiData.data.cover = heroImageId;
    strapiData.data.seo.metaImage = heroImageId;
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

// Webhook generique - Provider 1
app.post('/webhook/provider1', async (req, res) => {
  try {
    console.log('\n--- Webhook recu de Provider 1 ---');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    if (!verifyBearerToken(req, config.webhookApiKey1)) {
      console.log('Token invalide');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      title,
      content_html,
      content_markdown,
      metaDescription,
      keywords,
      heroImageUrl,
      test = false,
    } = req.body;

    if (test) {
      console.log('Test payload recu');
      return res.status(200).json({ message: 'Test webhook received successfully' });
    }

    const slug = slugify(title + ' ' + nanoid(), {
      lower: true,
      strict: true,
      locale: 'fr',
      trim: true,
    });

    if (!title || (!content_html && !content_markdown)) {
      console.log('Donnees manquantes (title ou content requis)');
      return res.status(400).json({ error: 'Missing required fields: title and content' });
    }

    let content = content_html || content_markdown;
    console.log(`Traitement de l'article: ${title}`);

    content = processHtmlContent(content);

    const { html: processedContent, images } = await processImagesInContent(content);

    let heroImageId = null;
    if (heroImageUrl) {
      console.log("Upload de l'image hero...");
      const heroImage = await downloadAndUploadImage(heroImageUrl, `hero-${slug}.jpg`);
      if (heroImage) {
        heroImageId = heroImage.id;
      }
    }

    const strapiResponse = await createNewsInStrapi({
      title,
      slug,
      processedContent,
      metaDescription,
      keywords,
      heroImageId,
    });

    console.log(`Article cree dans Strapi (ID: ${strapiResponse.data.id})`);

    res.status(200).json({
      success: true,
      message: 'Actualite publiee avec succes',
      articleId: strapiResponse.data.id,
      imagesUploaded: images.length + (heroImageId ? 1 : 0),
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

app.post('/log', async (req, res) => {
  console.log(req.body)
  return
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
  POST http://localhost:${config.port}/webhook/provider1
  POST http://localhost:${config.port}/test
==========================================================
  `);
});

module.exports = app;
