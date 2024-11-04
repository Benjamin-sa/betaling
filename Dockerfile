# Basis image voor Node.js
FROM node:20

# Maak een directory in de container
WORKDIR /usr/src/app

# Kopieer package.json en package-lock.json
COPY package*.json ./

# Installeer de afhankelijkheden
RUN npm install

# Kopieer de rest van de app-bestanden naar de container
COPY . .

# Environment variables laden
ARG NODE_ENV=geen
ENV NODE_ENV=$NODE_ENV

# Expose de poort 3000
EXPOSE 3000

# Start de app
CMD ["node", "server.js"]
