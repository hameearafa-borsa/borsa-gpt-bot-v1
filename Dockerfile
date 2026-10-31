FROM node:24-alpine
RUN apk add --no-cache font-noto fontconfig tesseract-ocr tesseract-ocr-data-ara tesseract-ocr-data-eng && fc-cache -f
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "index.js"]
