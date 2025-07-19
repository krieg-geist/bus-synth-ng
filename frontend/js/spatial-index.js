// Spatial grid index for efficient proximity queries
class SpatialIndex {
  constructor(bounds, gridSize = 50) {
    // bounds: [[minLat, maxLat], [minLon, maxLon]]
    this.bounds = bounds;
    this.gridSize = gridSize;
    
    // Calculate grid cell dimensions
    this.latRange = bounds[0][1] - bounds[0][0];
    this.lonRange = bounds[1][1] - bounds[1][0];
    this.cellLatSize = this.latRange / gridSize;
    this.cellLonSize = this.lonRange / gridSize;
    
    // Grid storage: Map<cellKey, Set<items>>
    this.grid = new Map();
  }

  // Get grid cell coordinates for a lat/lon point
  getCellCoords(lat, lon) {
    const latIndex = Math.floor((lat - this.bounds[0][0]) / this.cellLatSize);
    const lonIndex = Math.floor((lon - this.bounds[1][0]) / this.cellLonSize);
    
    // Clamp to grid bounds
    const clampedLatIndex = Math.max(0, Math.min(this.gridSize - 1, latIndex));
    const clampedLonIndex = Math.max(0, Math.min(this.gridSize - 1, lonIndex));
    
    return { lat: clampedLatIndex, lon: clampedLonIndex };
  }

  // Get cell key string
  getCellKey(latIndex, lonIndex) {
    return `${latIndex},${lonIndex}`;
  }

  // Add item to spatial index
  addItem(lat, lon, item) {
    const coords = this.getCellCoords(lat, lon);
    const key = this.getCellKey(coords.lat, coords.lon);
    
    if (!this.grid.has(key)) {
      this.grid.set(key, new Set());
    }
    
    this.grid.get(key).add(item);
  }

  // Get all items within radius of a point
  getItemsInRadius(lat, lon, radiusMeters) {
    const results = new Set();
    
    // Calculate how many cells to check based on radius
    const latRadius = radiusMeters / 111000; // Convert meters to degrees (approximate)
    const lonRadius = radiusMeters / (111000 * Math.cos(lat * Math.PI / 180)); // Account for longitude compression
    
    const cellsToCheck = Math.ceil(Math.max(latRadius / this.cellLatSize, lonRadius / this.cellLonSize));
    
    // Get center cell
    const centerCoords = this.getCellCoords(lat, lon);
    
    // Check surrounding cells
    for (let latOffset = -cellsToCheck; latOffset <= cellsToCheck; latOffset++) {
      for (let lonOffset = -cellsToCheck; lonOffset <= cellsToCheck; lonOffset++) {
        const checkLatIndex = centerCoords.lat + latOffset;
        const checkLonIndex = centerCoords.lon + lonOffset;
        
        // Skip if outside grid bounds
        if (checkLatIndex < 0 || checkLatIndex >= this.gridSize ||
            checkLonIndex < 0 || checkLonIndex >= this.gridSize) {
          continue;
        }
        
        const key = this.getCellKey(checkLatIndex, checkLonIndex);
        const cellItems = this.grid.get(key);
        
        if (cellItems) {
          cellItems.forEach(item => results.add(item));
        }
      }
    }
    
    return Array.from(results);
  }

  // Get items in the same cell (fastest lookup)
  getItemsInCell(lat, lon) {
    const coords = this.getCellCoords(lat, lon);
    const key = this.getCellKey(coords.lat, coords.lon);
    const cellItems = this.grid.get(key);
    
    return cellItems ? Array.from(cellItems) : [];
  }

  // Get statistics about the spatial index
  getStats() {
    const cellCounts = Array.from(this.grid.values()).map(set => set.size);
    const totalItems = cellCounts.reduce((sum, count) => sum + count, 0);
    const occupiedCells = cellCounts.length;
    const totalCells = this.gridSize * this.gridSize;
    const maxItemsPerCell = cellCounts.length > 0 ? Math.max(...cellCounts) : 0;
    const avgItemsPerCell = occupiedCells > 0 ? totalItems / occupiedCells : 0;
    
    return {
      totalItems,
      occupiedCells,
      totalCells,
      occupancyRate: (occupiedCells / totalCells * 100).toFixed(1) + '%',
      maxItemsPerCell,
      avgItemsPerCell: avgItemsPerCell.toFixed(1),
      cellSize: {
        lat: this.cellLatSize,
        lon: this.cellLonSize,
        approxMeters: (this.cellLatSize * 111000).toFixed(0) + 'm'
      }
    };
  }

  // Clear all items from the index
  clear() {
    this.grid.clear();
  }
}

window.SpatialIndex = SpatialIndex;
