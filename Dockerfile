FROM node:24-alpine
# The generic font-noto package does not include Arabic glyphs on Alpine.
# Install both Arabic families explicitly so librsvg/Pango can shape Arabic
# text in production PNGs instead of falling back to missing-glyph boxes.
RUN apk add --no-cache font-noto font-noto-arabic font-noto-naskh-arabic fontconfig tesseract-ocr tesseract-ocr-data-ara tesseract-ocr-data-eng \
    && fc-cache -f \
    && fc-match -f '%{family}\\n' 'Noto Sans Arabic' | grep -qi 'Noto Sans Arabic' \
    && fc-match -f '%{family}\\n' 'Noto Naskh Arabic' | grep -qi 'Noto Naskh Arabic'
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "index.js"]
