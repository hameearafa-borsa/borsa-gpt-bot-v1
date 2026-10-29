FROM node:24-alpine
RUN apk add --no-cache font-noto fontconfig && fc-cache -f
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "index.js"]
