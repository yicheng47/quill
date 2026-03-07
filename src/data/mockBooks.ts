export interface Book {
  id: string;
  title: string;
  author: string;
  cover: string;
  genre: string;
  description: string;
  pages: number;
  status: "reading" | "finished" | "unread";
  progress: number;
}

export const mockBooks: Book[] = [
  {
    id: "1",
    title: "The Digital Frontier",
    author: "Sarah Chen",
    cover: "https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=400&h=600&fit=crop",
    genre: "Science Fiction",
    description: "A journey through innovation and the future of humanity",
    pages: 3,
    status: "reading",
    progress: 45,
  },
  {
    id: "2",
    title: "Echoes of Tomorrow",
    author: "Marcus Reynolds",
    cover: "https://images.unsplash.com/photo-1512820790803-83ca734da794?w=400&h=600&fit=crop",
    genre: "Science Fiction",
    description: "Time travel paradoxes and quantum possibilities",
    pages: 12,
    status: "unread",
    progress: 0,
  },
  {
    id: "3",
    title: "The Last Mystery",
    author: "Elena Rodriguez",
    cover: "https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=400&h=600&fit=crop",
    genre: "Mystery",
    description: "A detective's final case in a city of shadows",
    pages: 15,
    status: "reading",
    progress: 78,
  },
  {
    id: "4",
    title: "Wisdom of Ages",
    author: "Dr. James Morrison",
    cover: "https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=400&h=600&fit=crop",
    genre: "Philosophy",
    description: "Exploring the fundamental questions of existence",
    pages: 20,
    status: "reading",
    progress: 23,
  },
  {
    id: "5",
    title: "Realms of Magic",
    author: "Isabella Thornwood",
    cover: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=400&h=600&fit=crop",
    genre: "Fantasy",
    description: "An epic tale of wizards, dragons, and ancient prophecies",
    pages: 18,
    status: "reading",
    progress: 56,
  },
  {
    id: "6",
    title: "Classic Tales",
    author: "Various Authors",
    cover: "https://images.unsplash.com/photo-1476275466078-4007374efbbe?w=400&h=600&fit=crop",
    genre: "Classics",
    description: "A collection of timeless literary masterpieces",
    pages: 10,
    status: "finished",
    progress: 100,
  },
];
