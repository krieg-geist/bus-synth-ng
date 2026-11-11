class WebSocketClient {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = SHARED_CONSTANTS.NETWORK.WS_RECONNECT_BASE_DELAY;
    this.onMessage = null;
    this.onStatusChange = null;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl;
    
    // Detect environment and configure WebSocket URL accordingly
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      // Development: Connect directly to WebSocket server port
      const wsPort = SHARED_CONSTANTS.NETWORK.DEFAULT_WS_PORT;
      wsUrl = `${protocol}//${window.location.hostname}:${wsPort}`;
    } else {
      // Production: Use proxied path through main web server
      wsUrl = `${protocol}//${window.location.host}/projects/bus-synth/ws`;
    }
    
    console.log(`Connecting to WebSocket: ${wsUrl}`);
    
    try {
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.updateStatus('Connected');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (this.onMessage) {
            this.onMessage(data);
          }
        } catch (error) {
          console.error('WebSocket message parse error:', error);
        }
      };

      this.ws.onclose = (event) => {
        console.log('WebSocket disconnected:', event.code, event.reason);
        this.isConnected = false;
        this.updateStatus('Disconnected');
        this.handleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.updateStatus('Error');
      };

    } catch (error) {
      console.error('WebSocket connection failed:', error);
      this.updateStatus('Failed');
      this.handleReconnect();
    }
  }

  // Keep trying (laptops sleep, servers restart), backing off to at most 30 s between attempts
  handleReconnect() {
    if (this.closing) return;
    this.reconnectAttempts++;
    this.updateStatus('Reconnecting');
    setTimeout(() => this.connect(), Math.min(30000, this.reconnectDelay * 2 ** (this.reconnectAttempts - 1)));
  }

  updateStatus(status) {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  disconnect() {
    this.closing = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

window.WebSocketClient = WebSocketClient;
