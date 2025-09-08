import { logInfo, logError } from '../../monitoring/logging/logger';

export interface QueueItem {
  id: string;
  type: 'casino_data' | 'casino_results' | 'casino_tv' | 'cricket_scorecard' | 'cricket_odds';
  gameType?: string;
  streamingId?: string;
  priority: number; // 1 = highest, 5 = lowest
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  scheduledFor: number;
  data?: any;
}

export interface QueueConfig {
  maxConcurrent: number;
  maxQueueSize: number;
  defaultPriority: number;
  retryDelay: number;
  maxRetryDelay: number;
  backoffMultiplier: number;
}

export class RequestQueue {
  private queue: QueueItem[] = [];
  private processing: Set<string> = new Set();
  private config: QueueConfig;
  private processors: Map<string, (item: QueueItem) => Promise<any>> = new Map();
  private isRunning = false;
  private stats = {
    totalProcessed: 0,
    totalFailed: 0,
    totalRetries: 0,
    averageWaitTime: 0,
    queueSize: 0
  };

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = {
      maxConcurrent: 3, // Max 3 concurrent API calls
      maxQueueSize: 1000,
      defaultPriority: 3,
      retryDelay: 1000, // 1 second base delay
      maxRetryDelay: 30000, // 30 seconds max delay
      backoffMultiplier: 2,
      ...config
    };
  }

  /**
   * Register a processor for a specific request type
   */
  registerProcessor(type: string, processor: (item: QueueItem) => Promise<any>) {
    this.processors.set(type, processor);
    logInfo(`📋 Registered processor for ${type}`);
  }

  /**
   * Add item to queue
   */
  async enqueue(item: Omit<QueueItem, 'id' | 'retryCount' | 'createdAt' | 'scheduledFor'>): Promise<string> {
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new Error('Queue is full');
    }

    const queueItem: QueueItem = {
      ...item,
      id: `${item.type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      retryCount: 0,
      createdAt: Date.now(),
      scheduledFor: Date.now()
    };

    // Insert based on priority (lower number = higher priority)
    const insertIndex = this.queue.findIndex(q => q.priority > queueItem.priority);
    if (insertIndex === -1) {
      this.queue.push(queueItem);
    } else {
      this.queue.splice(insertIndex, 0, queueItem);
    }

    this.stats.queueSize = this.queue.length;
    logInfo(`📋 Enqueued ${queueItem.type} for ${queueItem.gameType || 'general'} (Priority: ${queueItem.priority})`);
    
    // Start processing if not already running
    if (!this.isRunning) {
      this.startProcessing();
    }

    return queueItem.id;
  }

  /**
   * Start processing queue
   */
  private async startProcessing() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    logInfo('🚀 Starting request queue processor');

    while (this.isRunning) {
      try {
        // Process available slots
        const availableSlots = this.config.maxConcurrent - this.processing.size;
        
        for (let i = 0; i < availableSlots && this.queue.length > 0; i++) {
          const item = this.queue.shift();
          if (item && Date.now() >= item.scheduledFor) {
            this.processItem(item);
          } else if (item) {
            // Put back if not ready yet
            this.queue.unshift(item);
            break;
          }
        }

        // Wait before next iteration
        await this.sleep(100);
      } catch (error) {
        logError('❌ Error in queue processing loop:', error);
        await this.sleep(1000);
      }
    }
  }

  /**
   * Process individual queue item
   */
  private async processItem(item: QueueItem) {
    this.processing.add(item.id);
    
    try {
      const processor = this.processors.get(item.type);
      if (!processor) {
        throw new Error(`No processor registered for ${item.type}`);
      }

      const startTime = Date.now();
      const result = await processor(item);
      const processingTime = Date.now() - startTime;

      // Update stats
      this.stats.totalProcessed++;
      this.stats.averageWaitTime = (this.stats.averageWaitTime + processingTime) / 2;

      logInfo(`✅ Processed ${item.type} for ${item.gameType || 'general'} in ${processingTime}ms`);
      
    } catch (error) {
      logError(`❌ Failed to process ${item.type} for ${item.gameType || 'general'}:`, error);
      
      // Handle retry logic
      if (item.retryCount < item.maxRetries) {
        item.retryCount++;
        this.stats.totalRetries++;
        
        // Calculate exponential backoff with jitter
        const baseDelay = this.config.retryDelay * Math.pow(this.config.backoffMultiplier, item.retryCount - 1);
        const jitter = Math.random() * 1000; // Add up to 1 second jitter
        const delay = Math.min(baseDelay + jitter, this.config.maxRetryDelay);
        
        item.scheduledFor = Date.now() + delay;
        
        // Re-queue with delay
        const insertIndex = this.queue.findIndex(q => q.priority > item.priority);
        if (insertIndex === -1) {
          this.queue.push(item);
        } else {
          this.queue.splice(insertIndex, 0, item);
        }
        
        logInfo(`🔄 Scheduled retry ${item.retryCount}/${item.maxRetries} for ${item.type} in ${Math.round(delay)}ms`);
      } else {
        this.stats.totalFailed++;
        logError(`💀 Max retries exceeded for ${item.type} for ${item.gameType || 'general'}`);
      }
    } finally {
      this.processing.delete(item.id);
      this.stats.queueSize = this.queue.length;
    }
  }

  /**
   * Stop processing queue
   */
  stop() {
    this.isRunning = false;
    logInfo('🛑 Stopped request queue processor');
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      ...this.stats,
      processing: this.processing.size,
      queued: this.queue.length,
      isRunning: this.isRunning
    };
  }

  /**
   * Clear queue
   */
  clear() {
    this.queue = [];
    this.processing.clear();
    this.stats.queueSize = 0;
    logInfo('🧹 Cleared request queue');
  }

  /**
   * Get queue status for monitoring
   */
  getStatus() {
    return {
      queue: this.queue.map(item => ({
        id: item.id,
        type: item.type,
        gameType: item.gameType,
        priority: item.priority,
        retryCount: item.retryCount,
        scheduledFor: new Date(item.scheduledFor).toISOString(),
        waitTime: Date.now() - item.createdAt
      })),
      processing: Array.from(this.processing),
      stats: this.getStats()
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RequestQueue;

