# syntax=docker/dockerfile:1
# Ubuntu 24.04 + GDAL och PDAL ur Ubuntus paket så att rutorna kan reprojiceras
# server-side innan de packas i zip:en:
#   • gdalwarp       – markhöjdmodellen (GeoTIFF)
#   • pdal translate – laserdata (punktmoln, LAZ/COPC)
# OBS: PDAL finns INTE i Debians paket (bara i Ubuntus "universe"), därför
# Ubuntu-bas här i stället för node:*-bookworm. Node 20 läggs på via NodeSource.
# Konverteringen är frivillig (klienten skickar mål-CRS); utan mål-CRS strömmas
# rutorna oförändrade precis som förut.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs gdal-bin pdal \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 3001
CMD ["node", "server.js"]
