import type { ServerResponse } from "node:http"

interface Client {
  id: number
  response: ServerResponse
}

export class EventHub {
  private readonly clients = new Map<number, Client>()
  private nextClientId = 1
  private nextEventId = 1

  addClient(response: ServerResponse): () => void {
    const id = this.nextClientId++
    this.clients.set(id, { id, response })
    this.write(response, "control_plane.connected", { connected: true })

    const remove = () => this.clients.delete(id)
    response.once("close", remove)
    return remove
  }

  publish(event: string, data: unknown): void {
    for (const client of this.clients.values()) {
      this.write(client.response, event, data)
    }
  }

  close(): void {
    for (const client of this.clients.values()) client.response.end()
    this.clients.clear()
  }

  private write(response: ServerResponse, event: string, data: unknown): void {
    if (response.destroyed || response.writableEnded) return
    const id = this.nextEventId++
    response.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}
