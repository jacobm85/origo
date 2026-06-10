# syntax=docker/dockerfile:1
# PDAL finns INTE längre i Debians/Ubuntus apt-paket (borttaget uppströms), så
# verktygskedjan hämtas från conda-forge i stället – som dessutom ger den mest
# kompletta PDAL-byggen (filters.reprojection, readers.copc, LAZ-stöd) plus GDAL
# (gdalwarp) och Node 20 i samma kanal. /opt/conda/bin ligger på PATH i basen,
# så pdal/gdalwarp/node/npm är direkt anropbara (ingen env-aktivering behövs).
#   • gdalwarp       – markhöjdmodellen (GeoTIFF)
#   • pdal translate – laserdata (punktmoln, LAZ/COPC)
# Konverteringen är frivillig (klienten skickar mål-CRS); utan mål-CRS strömmas
# rutorna oförändrade precis som förut.
FROM condaforge/miniforge3:latest
RUN conda install -y -c conda-forge pdal gdal 'nodejs=20' \
 && conda clean -afy
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 3001
# Kör via "conda run" så att conda-miljöns aktiveringsskript sätter PROJ_DATA/
# GDAL_DATA m.m. Utan det hittar PROJ inte sin databas (proj.db) och pdal/
# gdalwarp avbryter med "Open of /opt/conda/share/proj failed". Barnprocesserna
# (pdal/gdalwarp) som node startar ärver miljön.
CMD ["conda", "run", "--no-capture-output", "-n", "base", "node", "server.js"]
