using System;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Concurrent;

namespace WebSocketServer
{
    public class WebSocketServerPlugin
    {
        private HttpListener _listener;
        private CancellationTokenSource _cts;
        private ConcurrentDictionary<string, WebSocket> _sockets = new ConcurrentDictionary<string, WebSocket>();

        // Events to send messages and status logs back to JavaScript
        public event Action<object> OnMessage;
        public event Action<object> OnStatus;

        public WebSocketServerPlugin()
        {
            // Empty public constructor
        }

        public void Start(int port, Action<object> callback)
        {
            try
            {
                if (_listener != null && _listener.IsListening)
                {
                    if (callback != null)
                    {
                        callback(new { success = true, message = "Already running" });
                    }
                    return;
                }

                _cts = new CancellationTokenSource();
                _listener = new HttpListener();
                _listener.Prefixes.Add(string.Format("http://127.0.0.1:{0}/", port));
                _listener.Start();

                Task.Run(() => AcceptConnectionsAsync(_cts.Token));

                LogStatus(string.Format("Server started on port {0}", port));
                if (callback != null)
                {
                    callback(new { success = true });
                }
            }
            catch (Exception ex)
            {
                LogStatus(string.Format("Error starting server: {0}", ex.Message));
                if (callback != null)
                {
                    callback(new { success = false, error = ex.Message });
                }
            }
        }

        public void Stop(Action<object> callback)
        {
            try
            {
                if (_cts != null)
                {
                    _cts.Cancel();
                }

                if (_listener != null)
                {
                    _listener.Stop();
                    _listener.Close();
                    _listener = null;
                }

                foreach (var ws in _sockets.Values)
                {
                    if (ws.State == WebSocketState.Open)
                    {
                        ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Server stopping", CancellationToken.None).Wait();
                    }
                }
                _sockets.Clear();

                LogStatus("Server stopped");
                if (callback != null)
                {
                    callback(new { success = true });
                }
            }
            catch (Exception ex)
            {
                if (callback != null)
                {
                    callback(new { success = false, error = ex.Message });
                }
            }
        }

        public void Send(string message, Action<object> callback)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(message);
                var segment = new ArraySegment<byte>(bytes);

                foreach (var kvp in _sockets)
                {
                    var ws = kvp.Value;
                    if (ws.State == WebSocketState.Open)
                    {
                        Task.Run(async () =>
                        {
                            try
                            {
                                await ws.SendAsync(segment, WebSocketMessageType.Text, true, CancellationToken.None);
                            }
                            catch (Exception ex)
                            {
                                LogStatus(string.Format("Error sending to {0}: {1}", kvp.Key, ex.Message));
                            }
                        });
                    }
                }
                if (callback != null)
                {
                    callback(new { success = true });
                }
            }
            catch (Exception ex)
            {
                if (callback != null)
                {
                    callback(new { success = false, error = ex.Message });
                }
            }
        }

        private async Task AcceptConnectionsAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested && _listener.IsListening)
            {
                try
                {
                    var context = await _listener.GetContextAsync();
                    if (context.Request.IsWebSocketRequest)
                    {
                        var wsContext = await context.AcceptWebSocketAsync(null);
                        var ws = wsContext.WebSocket;
                        var clientId = Guid.NewGuid().ToString();
                        _sockets[clientId] = ws;
                        LogStatus(string.Format("Client connected: {0}", clientId));

                        Task.Run(() => HandleClientAsync(clientId, ws, token));
                    }
                    else
                    {
                        context.Response.StatusCode = 400;
                        context.Response.Close();
                    }
                }
                catch (Exception ex)
                {
                    if (!token.IsCancellationRequested)
                    {
                        LogStatus(string.Format("Accept error: {0}", ex.Message));
                    }
                }
            }
        }

        private async Task HandleClientAsync(string clientId, WebSocket ws, CancellationToken token)
        {
            var buffer = new byte[8192];
            var segment = new ArraySegment<byte>(buffer);

            try
            {
                while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    var result = await ws.ReceiveAsync(segment, token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                        break;
                    }
                    else if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        
                        Action<object> onMessage = OnMessage;
                        if (onMessage != null)
                        {
                            onMessage(message);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                if (!token.IsCancellationRequested)
                {
                    LogStatus(string.Format("Client error {0}: {1}", clientId, ex.Message));
                }
            }
            finally
            {
                WebSocket removed;
                _sockets.TryRemove(clientId, out removed);
                LogStatus(string.Format("Client disconnected: {0}", clientId));
            }
        }

        private void LogStatus(string status)
        {
            Action<object> onStatus = OnStatus;
            if (onStatus != null)
            {
                onStatus(status);
            }
        }
    }
}
