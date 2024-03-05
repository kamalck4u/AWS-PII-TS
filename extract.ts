const AWS = require('aws-sdk');
const { PDFDocument, rgb } = require('pdf-lib');
const fs = require('fs');

AWS.config.update({ region: 'ap-southeast-1' }); // Set your AWS region

const textract = new AWS.Textract();
const comprehend = new AWS.Comprehend();
const s3 = new AWS.S3();

const downloadPdfFromS3 = async (bucket, fileKey) => {
  const params = {
    Bucket: bucket,
    Key: fileKey,
  };

  const data = await s3.getObject(params).promise();
  return data.Body;
};

const startTextDetection = async (bucket, document) => {
  const params = {
    DocumentLocation: {
      S3Object: {
        Bucket: bucket,
        Name: document
      }
    }
  };
  const response = await textract.startDocumentTextDetection(params).promise();
  return response.JobId;
};

const isJobComplete = async (jobId) => {
  const params = { JobId: jobId };
  const response = await textract.getDocumentTextDetection(params).promise();
  return response.JobStatus === 'SUCCEEDED';
};

const getJobResults = async (jobId) => {
  let pages = [];
  let nextToken = null;
  do {
    const params = {
      JobId: jobId,
      NextToken: nextToken
    };
    const response = await textract.getDocumentTextDetection(params).promise();
    pages = pages.concat(response.Blocks);
    nextToken = response.NextToken;
  } while (nextToken);
  return pages;
};

const extractTextPositions = async (bucket, document) => {
  const jobId = await startTextDetection(bucket, document);
  console.log("Text detection job started with ID:", jobId);

  while (!await isJobComplete(jobId)) {
    console.log("Waiting for text detection job to complete...");
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const results = await getJobResults(jobId);
  return results.filter(item => item.BlockType === 'LINE').map(item => ({
    Text: item.Text,
    Geometry: item.Geometry.BoundingBox,
    Page: item.Page,
  }));
};

const detectPII = async (text) => {
  const params = {
    Text: text,
    LanguageCode: 'en',
  };
  const response = await comprehend.detectPiiEntities(params).promise();
  return response.Entities;
};

const applyRedactions = async (pdfBytes, textData, piiEntities, fullText) => {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  piiEntities.forEach(entity => {
    // Use entity offsets to identify the text
    const piiText = fullText.substring(entity.BeginOffset, entity.EndOffset);

    textData.forEach(text => {
      if (text.Text.includes(piiText)) {
        const { Page, Geometry } = text;
        const page = pages[Page - 1];
        
        const x = Geometry.Left * page.getWidth();
        const y = (1 - Geometry.Top) * page.getHeight() - (Geometry.Height * page.getHeight());
        const width = Geometry.Width * page.getWidth();
        const height = Geometry.Height * page.getHeight();

        page.drawRectangle({
          x,
          y,
          width,
          height,
          color: rgb(0, 0, 0),
        });
      }
    });
  });

  const redactedPdfBytes = await pdfDoc.save();
  const redactedPdfPath = 'redacted_document.pdf';
  fs.writeFileSync(redactedPdfPath, redactedPdfBytes);
  console.log(`Redacted PDF saved to ${redactedPdfPath}`);
};




(async () => {
  const bucketName = 'bucketname';
  const subfolder = 'subfoldername';
  const documentFilename = 'documentFilename';
  const documentPath = `${subfolder}/${documentFilename}`;

  const pdfBytes = await downloadPdfFromS3(bucketName, documentPath);

  const textData = await extractTextPositions(bucketName, documentPath);
  const fullText = textData.map(item => item.Text).join(' ');
  console.log(fullText);

  const piiEntities = await detectPII(fullText);
  console.log(piiEntities);

  await applyRedactions(pdfBytes, textData, piiEntities, fullText);

})();
