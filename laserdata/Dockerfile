# syntax=docker/dockerfile:1
# Node 20 (officiell Debian-bookworm-image) + GDAL och PDAL ur Debians paket så
# att rutorna kan reprojiceras server-side innan de packas i zip:en:
#   • gdalwarp     – markhöjdmodellen (GeoTIFF)
#   • pdal translate – laserdata (punktmoln, LAZ/COPC)
# Konverteringen är frivillig (klienten skickar mål-CRS); utan mål-CRS strömmas
# rutorna oförändrade precis som förut.
FROM node:20-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends gdal-bin pdal \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 3001
CMD ["node", "server.js"]
