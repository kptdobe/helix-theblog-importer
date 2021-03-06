
/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
/* eslint-disable max-len */
const { wrap } = require('@adobe/openwhisk-action-utils');
const { logger: oLogger } = require('@adobe/openwhisk-action-logger');
const { wrap: status } = require('@adobe/helix-status');
const { epsagon } = require('@adobe/helix-epsagon');
const { BlobHandler } = require('@adobe/helix-documents-support');

const cheerio = require('cheerio');
const moment = require('moment');
const escape = require('escape-html');
const path = require('path');
const rp = require('request-promise-native');
const sanitize = require('sanitize-filename');

const HelixImporter = require('./generic/HelixImporter');
const { asyncForEach } = require('./generic/utils');
const { load: loadMappings } = require('./mappings');

const OneDriveHandler = require('./handlers/OneDriveHandler');
const FSHandler = require('./handlers/FSHandler');
const ExcelHandler = require('./handlers/ExcelHandler');
const FastlyHandler = require('./handlers/FastlyHandler');

const OUTPUT_PATH = 'en';

const TYPE_AUTHOR = 'authors';
const TYPE_POST = 'publish';
const TYPE_TOPIC = 'topics';
const TYPE_PRODUCT = 'products';
const TYPE_BANNER = 'promotions';

const TYPE_PRODUCT_ICONS = 'icons';

const URLS_XLSX = '/importer/urls.xlsx';
const URLS_XLSX_WORKSHEET = 'urls';
const URLS_XLSX_TABLE = 'listOfURLS';

const EMBED_PATTERNS = [{
  // w.soundcloud.com/player
  match: (node) => {
    const f = node.find('iframe');
    const src = f.attr('src');
    return src && src.match(/w.soundcloud.com\/player/gm);
  },
  extract: async (node, logger) => {
    const f = node.find('iframe');
    const src = f.attr('src');
    try {
      const html = await rp({
        uri: src,
        timeout: 60000,
        simple: false,
        headers: {
          // does not give the canonical rel without the UA.
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36',
        },
      });
      if (html && html !== '') {
        const $ = cheerio.load(html);
        return $('link[rel="canonical"]').attr('href') || src;
      }
    } catch (error) {
      logger.warn(`Cannot resolve soundcloud embed ${src}`);
      return src;
    }
    return src;
  },
}, {
  // www.instagram.com
  match: (node) => node.find('.instagram-media').length > 0,
  extract: async (node) => node.find('.instagram-media').data('instgrm-permalink'),
}, {
  // www.instagram.com v2
  match: (node) => node.find('.instagram-media').length > 0,
  extract: async (node) => node.find('.instagram-media a').attr('href'),
}, {
  // twitter.com
  match: (node) => node.find('.twitter-tweet a').length > 0,
  extract: async (node) => {
    // latest <a> seems to be the link to the tweet
    const aTags = node.find('.twitter-tweet a');
    return aTags[aTags.length - 1].attribs.href;
  },
}, {
  // spark
  match: (node) => node.find('a.asp-embed-link').length > 0,
  extract: async (node) => node.find('a.asp-embed-link').attr('href'),
}, {
  // media.giphy.com
  match: (node) => {
    const img = node.find('img');
    const src = img ? img.attr('src') : null;
    return src && src.match(/media.giphy.com/gm);
  },
  extract: async (node) => {
    const img = node.find('img');
    return img.attr('src');
  },
}, {
  // fallback to iframe src
  match: (node) => {
    const f = node.find('iframe');
    return f.attr('src') || f.data('src');
  },
  extract: (node) => {
    const f = node.find('iframe');
    return f.attr('src') || f.data('src');
  },
}];

async function handleAuthor(importer, $, postedOn, checkIfExists) {
  let postedBy = $('.author-link').text();
  postedBy = postedBy.split(',')[0].trim();
  const authorLink = $('.author-link').attr('href');

  const nodes = [];
  nodes.push($('<p>').append(`by ${postedBy}`));
  nodes.push($('<p>').append(postedOn));

  const authorFilename = importer.sanitizeFilename(postedBy);

  if (authorFilename && authorFilename !== '' && (!checkIfExists || !await importer.exists(`${OUTPUT_PATH}/${TYPE_AUTHOR}`, authorFilename))) {
    const html = await importer.getPageContent(authorLink);

    if (html && html !== '') {
      const $2 = cheerio.load(html);

      const $main = $2('.author-header');

      // convert author-img from div to img for auto-processing
      const $div = $2('.author-header .author-img');
      const urlstr = $div.css('background-image');
      const url = /\(([^)]+)\)/.exec(urlstr)[1];
      $main.prepend(`<img src="${url}">`);
      $div.remove();

      // handle social list
      if ($2('.author-social-list .author-social-item').length > 0) {
        // prepend "Social:" text (only if links)
        $2('<span>Social:</span>').insertBefore('.author-social-list');
        $2('.author-social-list a').each((i, a) => {
          const $a = $2(a);
          const href = $a.attr('href');
          if (href) {
            $a.html(href);
          }
        });
      }

      const content = $main.html();
      await importer.createMarkdownFile(`${OUTPUT_PATH}/${TYPE_AUTHOR}`, authorFilename, content);
    }
  }

  return nodes;
}

async function handleBanner(node, $, importer, checkIfExists) {
  const href = node.find('.cta.source-code').attr('href');
  if (!href) {
    // do not import banners without a valid cta
    return null;
  }

  const title = node.find('h2').text();

  // use title if available or fallback to name in the href
  const bannerFilename = importer.sanitizeFilename(title || path.parse(href).name);

  if (bannerFilename !== '' && (!checkIfExists || !await importer.exists(`${OUTPUT_PATH}/${TYPE_BANNER}`, bannerFilename))) {
    const content = [];
    content.push(`<h1>${title}</h1>`);

    const productWrap = node.find('.product-banner-wrap');
    if (productWrap) {
      const bannerImg = productWrap.css('background-image');
      if (bannerImg) {
        // remove url()
        content.push(`<img src="${bannerImg.replace(/url\((.*)\)/, '$1')}">`);
      }
    }

    const pText = [];
    node.find('p').each((i, p) => {
      const $p = $(p);
      const t = $p.text().trim();
      if (t !== '') {
        pText.push(t);
      }
    });

    if (pText.length === 0) {
      // some variation...
      const html = node.find('.text-2-block').html();
      if (html) {
        pText.push(html);
      }
    }

    content.push(`<p>${pText.join('<br>')}</p>`);
    content.push(`<a href="${href}">${node.find('.cta.source-code span').html()}</a>`);

    const productIcon = node.find('.product-icon');
    if (productIcon && productIcon.length > 0) {
      content.push(`<br><br><img src="${productIcon.attr('src')}">`);
    }
    await importer.createMarkdownFile(`${OUTPUT_PATH}/${TYPE_BANNER}`, bannerFilename, content.join(''), '---\nclass: banner\n---\n\n');
  }

  // convert to internal embed
  return `<hlxembed>/${OUTPUT_PATH}/${TYPE_BANNER}/${sanitize(bannerFilename)}.html</hlxembed>`;
}

async function handleTopics(importer, $, checkIfExists, mappings, logger) {
  let mainTopic = escape($('[property="article:section"]').attr('content') || '');
  mainTopic = mainTopic ? mainTopic.trim().replace(/&amp;/g, '&') : '';

  let topics = [];
  $('.article-footer-topics-wrap .text').each((i, t) => {
    let topic = $(t).html();
    topic = topic ? topic.trim().replace(/&amp;/g, '&') : null;
    const topicLC = topic.toLowerCase();

    if (topic && mappings.categories[topicLC]) {
      if (topic === mainTopic) {
        // add first
        topics.unshift(0, mappings.categories[topicLC][0]);
      } else {
        topics.push(mappings.categories[topicLC][0]);
      }
    } else {
      throw new Error(`Found an unmapped topic: ${topic}`);
    }
  });

  topics = topics.filter((t, i) => t && t.length > 0 && topics.indexOf(t) === i).map((t) => t.trim());

  await asyncForEach(
    topics,
    async (t) => {
      const topicName = importer.sanitizeFilename(t);
      if (!checkIfExists || !await importer.exists(`${OUTPUT_PATH}/${TYPE_TOPIC}`, topicName)) {
        logger.info(`Found a new topic: ${topicName}`);
        await importer.createMarkdownFile(`${OUTPUT_PATH}/${TYPE_TOPIC}`, topicName, `<h1>${t}</h1>`);
      }
    },
  );

  return topics.join(', ');
}

async function handleProducts(importer, $, checkIfExists, doCreateAssets, mappings, logger) {
  let output = [];
  const products = [];
  $('.sidebar-products-row .product-team-link').each((i, p) => {
    const $p = $(p);

    const src = $p.find('img').attr('src');
    let { name } = path.parse(src);

    name = name.replace(/-/g, ' ').replace(/\b[a-z](?=[a-z]{2})/g, (letter) => letter.toUpperCase());

    let productMapping = mappings.products[name.toLowerCase()] || mappings.products[`adobe ${name.toLowerCase()}`];
    if (!productMapping) {
      // try with href
      name = path.parse($(p).attr('href')).name;

      // edge case, some link redirect to homepage, try to get product from image src
      if (name === 'en') {
        name = path.parse(src).name;
      }

      name = name.replace(/-/g, ' ').replace(/\b[a-z](?=[a-z]{2})/g, (letter) => letter.toUpperCase());

      productMapping = mappings.products[name.toLowerCase()] || mappings.products[`adobe ${name.toLowerCase()}`];
    }

    if (productMapping) {
      const fileName = productMapping[0].replace(/\s/g, '-').toLowerCase();
      products.push({
        name: productMapping[0],
        fileName,
        href: $p.attr('href'),
        imgSrc: src,
      });
      output.push(productMapping[0]);
    } else {
      throw new Error(`Found an unmapped topic: ${name}`);
    }
  });

  // keyword based search
  const postBody = $('body').html().toLowerCase();
  // eslint-disable-next-line no-restricted-syntax
  for (const k in mappings.productKeywords) {
    if (postBody.indexOf(k) !== -1 && output.indexOf(k) === -1) {
      const productMapping = mappings.products[k];
      if (productMapping) {
        const fileName = importer.sanitizeFilename(productMapping[0]);
        products.push({
          name: productMapping[0],
          fileName,
        });
        output = output.concat(productMapping);
      } else {
        throw new Error(`Found an unmapped topic (keyword search): ${k}`);
      }
    }
  }

  await asyncForEach(
    products,
    async (p) => {
      if (!checkIfExists || !await importer.exists(`${OUTPUT_PATH}/${TYPE_PRODUCT}`, p.fileName)) {
        logger.info(`Found a new product: ${p.name}`);
        let content = `<h1>${p.name}</h1><img src='${p.imgSrc || ''}'>`;
        if (p.href) {
          content = `<h1>${p.name}</h1><a href='${p.href}'><img src='${p.imgSrc}'></a>`;
        }
        await importer.createMarkdownFile(`${OUTPUT_PATH}/${TYPE_PRODUCT}`, `${p.fileName}`, content, null, `${TYPE_PRODUCT_ICONS}`, doCreateAssets);
      }
    },
  );

  return output.filter((p, i) => p && p.length > 0 && output.lastIndexOf(p) === i).join(', ');
}

function reviewInlineElement($, tagName) {
  // collaspe consecutive <tag>
  // and make sure element does not start ends with spaces while it is before / after some text
  const tags = $(tagName).toArray();
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const tag = tags[i];
    const $tag = $(tag);
    let text = $tag.text();
    if (tag.previousSibling) {
      const $previousSibling = $(tag.previousSibling);
      if (tag.previousSibling.tagName === tagName) {
        // previous sibling is an <tag>, merge current one inside the previous one
        $previousSibling.append($tag.html());
        $tag.remove();
      }
    }
    if (text) {
      if (text.lastIndexOf(' ') === text.length - 1) {
        // move trailing space to a new text node outside of current element
        text = $tag.text(text.slice(0, text.length - 1)).text();
        $('<span> </span>').insertAfter($tag);
      }

      if (text.indexOf(' ') === 0) {
        // move leading space to a new text node outside of current element
        text = $tag.text(text.slice(1)).text();
        $('<span> </span>').insertBefore($tag);
      }
    }
  }
}

async function doImport(importer, url, checkIfRelatedExists, doCreateAssets = false, mappings, logger) {
  const html = await importer.getPageContent(url);

  if (html && html !== '') {
    const $ = cheerio.load(html);

    let date = 'unknown';

    const postedOn = $('.post-date').text().toLowerCase();
    if (postedOn) {
      const d = moment(postedOn, 'MM-DD-YYYY');
      date = d.format('YYYY/MM/DD');
    } else {
      // fallback to article:published_time metadata
      const pubDate = $('[property="article:published_time"]').attr('content');
      if (pubDate) {
        const d = moment(pubDate);
        date = d.format('YYYY/MM/DD');
      }
    }

    const $main = $('.main-content');

    // remove all existing hr to avoid section collisions
    $main.find('hr').remove();

    // remove all hidden elements
    $main.find('.hidden-md-down, .hidden-xs-down').remove();

    // add a thematic break after first titles
    $('<hr>').insertAfter($('.article-header'));

    // add a thematic break after hero banner
    const $heroHr = $('<hr>').insertAfter($('.article-hero'));

    // remove anti-hero (legacy design)
    $('.anti-hero').remove();

    $('<hr>').insertAfter($heroHr);
    const nodes = await handleAuthor(importer, $, postedOn, checkIfRelatedExists, logger);
    let previous = $heroHr;
    nodes.forEach((n) => {
      previous = n.insertAfter(previous);
    });

    const topics = await handleTopics(importer, $, checkIfRelatedExists, mappings, logger);
    const products = await handleProducts(importer, $, checkIfRelatedExists, doCreateAssets, mappings, logger);

    const $topicsWrap = $('<p>');
    $topicsWrap.html(`Topics: ${topics}`);
    const $productsWrap = $('<p>');
    $productsWrap.html(`Products: ${products}`);

    $main.append($topicsWrap);
    $main.append($productsWrap);
    $('<hr>').insertBefore($topicsWrap);

    const headers = $('.article-header');
    if (headers.length === 0) {
      // posts with headers after image
      const $articleRow = $('.article-title-row');
      $('.article-content').prepend($articleRow);
      $('<hr>').insertAfter($articleRow);
    }
    $('.article-collection-header').remove();

    // embeds
    await asyncForEach($('.embed-wrapper, .spotify-wrapper').toArray(), async (node) => {
      const $node = $(node);

      let src;
      await asyncForEach(
        EMBED_PATTERNS,
        async (p) => {
          if (p.match($node)) {
            src = await p.extract($node, logger);
          }
          return src;
        },
      );

      if (!src) {
        // throw new Error('Unsupported embed - no src found');
        logger.warn(`Unsupported embed - could not resolve embed src in ${url}`);
      } else {
        if (src.indexOf('//') === 0) {
          // handle weird url starting with //
          src = `https:${src}`;
        }

        // replace children by "hlxembed" custom tag
        $node.children().remove();
        $node.append(`<hlxembed>${src}</hlxembed>`);
      }
    });
    // there might be some remaining iframes, just use the src as an embed.
    $('iframe').each((i, iframe) => {
      const $f = $(iframe);
      if ($f.attr('src') || $f.data('src')) {
        $(`<hlxembed>${$f.attr('src') || $f.data('src')}</hlxembed>`).insertAfter($f);
      }
      $f.remove();
    });

    // banners
    await asyncForEach($('.product-banner-col').toArray(), async (node) => {
      const $node = $(node);
      const embed = await handleBanner($node, $, importer, checkIfRelatedExists, logger);
      if (embed) {
        $node.after(embed);
      }
      $node.remove();
    });

    // collaspe consecutive <em>, <strong>, <u>, <i>...
    // and make sure they do not start / end with spaces while it is before / after some text

    ['a', 'b', 'big', 'code', 'em', 'i', 'label', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'var'].forEach((tag) => reviewInlineElement($, tag));

    // remove author / products section
    $('.article-author-wrap').remove();
    // remove footer
    $('.article-footer').remove();
    // remove nav
    $('#article-nav-wrap').remove();
    // remove 'products in article'
    $('.article-body-products').remove();
    // remove comments section
    $('.comments').remove();

    const content = $main.html();

    await importer.createMarkdownFile(`${OUTPUT_PATH}/${TYPE_POST}/${date}`, path.parse(url).name, content);

    return date;
  }
  return 'N/A';
}

/**
 * This is the main function
 * @param {string} name name of the person to greet
 * @returns {object} a greeting
 */
async function main(params = {}) {
  const startTime = new Date().getTime();
  const {
    url,
    force = true,
    checkIfRelatedExists = true,
    __ow_logger: logger,
    AZURE_BLOB_SAS: azureBlobSAS,
    AZURE_BLOB_URI: azureBlobURI,
    AZURE_ONEDRIVE_CLIENT_ID: oneDriveClientId,
    AZURE_ONEDRIVE_CLIENT_SECRET: oneDriveClientSecret,
    AZURE_ONEDRIVE_REFRESH_TOKEN: oneDriveRefreshToken,
    AZURE_ONEDRIVE_CONTENT_LINK: oneDriveContentLink,
    AZURE_ONEDRIVE_ADMIN_LINK: oneDriveAdminLink,
    FASTLY_TOKEN,
    FASTLY_SERVICE_ID,
    localStorage,
    cache,
    doCreateAssets,
    updateExcel = true,
  } = params;

  let { mappings } = params;

  if (!url) {
    throw new Error('Missing url parameter');
  }

  if (!azureBlobSAS || !azureBlobURI) {
    throw new Error('Missing Azure Blog Storage credentials');
  }

  try {
    let handler;
    let excelHandler;

    if (oneDriveClientId && oneDriveClientSecret) {
      if (!localStorage) {
        logger.info('OneDrive credentials provided - using OneDrive handler');
        handler = new OneDriveHandler({
          logger,
          clientId: oneDriveClientId,
          clientSecret: oneDriveClientSecret,
          refreshToken: oneDriveRefreshToken,
          sharedLink: oneDriveContentLink,
        });
      } else {
        logger.info('localStorage provided - using FShandler');
        handler = new FSHandler({
          logger,
          target: localStorage,
        });
      }

      excelHandler = new ExcelHandler({
        logger,
        clientId: oneDriveClientId,
        clientSecret: oneDriveClientSecret,
        refreshToken: oneDriveRefreshToken,
        sharedLink: oneDriveAdminLink,
      });
    } else {
      logger.info('No OneDrive credentials provided');
      throw new Error('Missing OneDrive credentials');
    }

    logger.info(`Received url ${url}`);

    if (!force) {
      // check if url has already been processed
      const rows = await excelHandler.getRows(URLS_XLSX, URLS_XLSX_WORKSHEET, URLS_XLSX_TABLE);

      // rows.value[n].values[0][0] -> year
      // rows.value[n].values[0][1] -> url
      // rows.value[n].values[0][2] -> import date
      const index = rows && rows.value
        ? rows.value.findIndex(
          (r) => (r.values.length > 0 && r.values[0].length > 1 ? r.values[0][1] === url : false),
        )
        : -1;
      const rec = index > -1 ? rows.value[index] : null;
      if (rec && rec.values[0][2]) {
        // url has already been imported
        return Promise.resolve({
          body: `${url} has already been imported.`,
        });
      }
    }

    if (!mappings) {
      // load the mappings
      mappings = await loadMappings(excelHandler);
    }

    const importer = new HelixImporter({
      storageHandler: handler,
      blobHandler: new BlobHandler({
        azureBlobSAS,
        azureBlobURI,
        log: {
          debug: () => {},
          info: () => {},
          error: (msg) => { logger.error(msg); },
          warn: (msg) => { logger.warn(msg); },
        },
      }),
      logger,
      cache,
    });

    const date = await doImport(importer, url, checkIfRelatedExists, doCreateAssets, mappings, logger);

    if (FASTLY_SERVICE_ID && FASTLY_TOKEN) {
      const fastly = new FastlyHandler({
        fastlyServiceId: FASTLY_SERVICE_ID,
        fastlyToken: FASTLY_TOKEN,
      });

      await fastly.addDictEntry(url, date);
    } else {
      logger.warn('Unable to create redirect, check FASTLY_SERVICE_ID and FASTLY_TOKEN');
    }

    if (updateExcel) {
      await excelHandler.addRow(
        URLS_XLSX,
        URLS_XLSX_WORKSHEET,
        URLS_XLSX_TABLE,
        [[date, url, new Date().toISOString()]],
      );
    }

    logger.info(`Process done in ${(new Date().getTime() - startTime) / 1000}s.`);
    return {
      body: `Successfully imported ${url}`,
      data: [date, url, new Date().toISOString()],
      statusCode: 200,
    };
  } catch (error) {
    logger.error(error.message);
    return {
      statusCode: 500,
      body: `Error for ${url} import: ${error.stack}`,
    };
  }
}

module.exports.main = wrap(main)
  .with(epsagon)
  .with(status)
  .with(oLogger.trace)
  .with(oLogger);
