
export type MimeType = 'image/jpeg' | 'image/png';

export interface ImageData {
    mimeType: MimeType;
    data: string; // base64 encoded string
}

export interface GroundingChunk {
    web: {
        uri: string;
        title: string;
    };
}

export interface ChatMessage {
    id: number;
    sender: 'user' | 'ai';
    text: string;
    image?: ImageData;
    generatedImage?: string; // base64 encoded string
    groundingChunks?: GroundingChunk[];
}

export type ModuleId = 'calendar' | 'pitch' | 'marketing' | 'communication' | 'insights' | 'research' | 'analysis' | 'voice';

export interface Module {
    id: ModuleId;
    name: string;
    icon: string;
    systemInstruction: string;
    welcomeMessage: string;
}

export interface Subtask {
    id: string;
    text: string;
    completed: boolean;
}

export interface CalendarEvent {
    id:string;
    title: string;
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    priority: 'low' | 'medium' | 'high';
    subtasks?: Subtask[];
}

export interface Insight {
    id: string;
    summary: string;
    trends: string[];
    actions: string[];
}
