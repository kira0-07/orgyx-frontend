'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Settings, Save, Loader2, RefreshCw, Search, ChevronDown, ChevronUp, Plus
} from 'lucide-react';
import api from '@/lib/axios';
import { useAuth } from '@/context/AuthContext';
import { CardSkeleton, FormSkeleton } from '@/components/shared/Skeleton';
import toast from 'react-hot-toast';

export default function AdminPromptsPage() {
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);   // which card is open
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newTemplate, setNewTemplate] = useState({
    name: '',
    domain: '',
    description: '',
    systemPrompt: '',
    userPromptTemplate: '',
    isActive: true
  });

  useEffect(() => {
    if (!authLoading && !isAdmin) {
      router.push('/dashboard');
      return;
    }
    fetchTemplates();
  }, [authLoading, isAdmin, router]);

  const fetchTemplates = async () => {
    try {
      const response = await api.get('/admin/prompts');
      setTemplates(response.data.templates || []);
    } catch (error) {
      console.error('Failed to fetch templates:', error);
      toast.error('Failed to fetch prompt templates');
    } finally {
      setIsLoading(false);
    }
  };

  const saveTemplate = async () => {
    if (!editingTemplate) return;
    setIsSaving(true);
    try {
      await api.put(`/admin/prompts/${editingTemplate._id}`, {
        systemPrompt: editingTemplate.systemPrompt,
        userPromptTemplate: editingTemplate.userPromptTemplate,
      });
      toast.success('Template updated successfully');
      setEditingTemplate(null);
      fetchTemplates();
    } catch (error) {
      console.error('Failed to save template:', error);
      toast.error('Failed to save template');
    } finally {
      setIsSaving(false);
    }
  };

  const createTemplate = async () => {
    if (!newTemplate.name || !newTemplate.domain) {
      toast.error('Name and Domain are required');
      return;
    }
    setIsSaving(true);
    try {
      await api.post('/admin/prompts', newTemplate);
      toast.success('Template created successfully');
      setIsCreating(false);
      setNewTemplate({
        name: '',
        domain: '',
        description: '',
        systemPrompt: '',
        userPromptTemplate: '',
        isActive: true
      });
      fetchTemplates();
    } catch (error) {
      console.error('Failed to create template:', error);
      toast.error('Failed to create template');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleExpand = (id) => {
    setExpandedId(prev => prev === id ? null : id);
    // cancel any in-progress edit when collapsing
    if (expandedId === id) setEditingTemplate(null);
  };

  const startEdit = (template, e) => {
    e.stopPropagation();
    setEditingTemplate({ ...template });
    setExpandedId(template._id);
  };

  const cancelEdit = () => setEditingTemplate(null);

  const filteredTemplates = templates.filter(t =>
    t.name?.toLowerCase().includes(search.toLowerCase()) ||
    t.domain?.toLowerCase().includes(search.toLowerCase())
  );

  if (authLoading || isLoading) {
    return (
      <>
        <div className="space-y-6">
          <h1 className="text-3xl font-bold">Prompt Templates</h1>
          <FormSkeleton />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Prompt Templates</h1>
            <p className="text-muted-foreground">Manage AI prompt templates for meeting analysis</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchTemplates} className="border-slate-700">
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button onClick={() => setIsCreating(true)} className="bg-primary hover:bg-primary/90">
              <Plus className="mr-2 h-4 w-4" />
              Add Prompt
            </Button>
          </div>
        </div>

        {/* Create New Template Form */}
        {isCreating && (
          <Card className="bg-card border-primary/50 border-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5 text-primary" />
                Create New Prompt Template
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Template Name <span className="text-destructive">*</span></Label>
                  <Input
                    placeholder="e.g. Sprint Planning Analysis"
                    value={newTemplate.name}
                    onChange={(e) => setNewTemplate(prev => ({ ...prev, name: e.target.value }))}
                    className="bg-muted border-slate-700"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Domain / Slug <span className="text-destructive">*</span></Label>
                  <Input
                    placeholder="e.g. Sprint-Planning"
                    value={newTemplate.domain}
                    onChange={(e) => setNewTemplate(prev => ({ ...prev, domain: e.target.value }))}
                    className="bg-muted border-slate-700"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  placeholder="Short description of what this template is for..."
                  value={newTemplate.description}
                  onChange={(e) => setNewTemplate(prev => ({ ...prev, description: e.target.value }))}
                  className="bg-muted border-slate-700"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">System Prompt</Label>
                <Textarea
                  value={newTemplate.systemPrompt}
                  onChange={(e) => setNewTemplate(prev => ({ ...prev, systemPrompt: e.target.value }))}
                  className="bg-muted border-slate-700 min-h-[180px] font-mono text-sm"
                  placeholder="The system instructions for the AI..."
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">User Prompt Template</Label>
                <Textarea
                  value={newTemplate.userPromptTemplate}
                  onChange={(e) => setNewTemplate(prev => ({ ...prev, userPromptTemplate: e.target.value }))}
                  className="bg-muted border-slate-700 min-h-[140px] font-mono text-sm"
                  placeholder="Template with variables like {transcript}..."
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsCreating(false)}
                  className="border-slate-700"
                >
                  Cancel
                </Button>
                <Button onClick={createTemplate} disabled={isSaving}>
                  {isSaving ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</>
                  ) : (
                    <><Save className="mr-2 h-4 w-4" />Create Template</>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Search */}
        <Card className="bg-card border-muted">
          <CardContent className="py-4">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
              <Input
                placeholder="Search templates..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10 bg-muted border-slate-700"
              />
            </div>
          </CardContent>
        </Card>

        {/* Templates List */}
        <div className="space-y-4">
          {filteredTemplates.length === 0 ? (
            <Card className="bg-card border-muted">
              <CardContent className="text-center py-12 text-muted-foreground">
                <Settings className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No templates found</p>
              </CardContent>
            </Card>
          ) : (
            filteredTemplates.map((template) => {
              const isExpanded = expandedId === template._id;
              const isEditing = editingTemplate?._id === template._id;

              return (
                <Card key={template._id} className="bg-card border-muted">
                  {/* ── Header — always visible, click to expand ── */}
                  <CardHeader
                    className="cursor-pointer select-none"
                    onClick={() => toggleExpand(template._id)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <Settings className="h-5 w-5" />
                          {template.name}
                        </CardTitle>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" className="bg-muted text-muted-foreground">
                            {template.domain}
                          </Badge>
                          <Badge variant="secondary" className="bg-muted text-muted-foreground">
                            v{template.version || 1}
                          </Badge>
                          {template.isActive && (
                            <Badge className="bg-green-500/20 text-green-400">Active</Badge>
                          )}
                        </div>
                        {template.description && (
                          <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isExpanded && !isEditing && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => startEdit(template, e)}
                            className="border-slate-700"
                          >
                            Edit
                          </Button>
                        )}
                        {isExpanded
                          ? <ChevronUp className="h-5 w-5 text-muted-foreground" />
                          : <ChevronDown className="h-5 w-5 text-muted-foreground" />
                        }
                      </div>
                    </div>
                  </CardHeader>

                  {/* ── Expanded content ── */}
                  {isExpanded && (
                    <CardContent className="space-y-6 pt-0">

                      {isEditing ? (
                        /* ── EDIT MODE ── */
                        <>
                          <div className="space-y-2">
                            <Label className="text-muted-foreground">System Prompt</Label>
                            <Textarea
                              value={editingTemplate.systemPrompt || ''}
                              onChange={(e) => setEditingTemplate(prev => ({
                                ...prev, systemPrompt: e.target.value
                              }))}
                              className="bg-muted border-slate-700 min-h-[220px] font-mono text-sm"
                              placeholder="System prompt..."
                            />
                          </div>

                          <div className="space-y-2">
                            <Label className="text-muted-foreground">User Prompt Template</Label>
                            <Textarea
                              value={editingTemplate.userPromptTemplate || ''}
                              onChange={(e) => setEditingTemplate(prev => ({
                                ...prev, userPromptTemplate: e.target.value
                              }))}
                              className="bg-muted border-slate-700 min-h-[160px] font-mono text-sm"
                              placeholder="User prompt template with {variables}..."
                            />
                            <p className="text-xs text-muted-foreground">
                              Available variables: <code className="text-blue-400">{'{transcript}'}</code>{' '}
                              <code className="text-blue-400">{'{attendees}'}</code>{' '}
                              <code className="text-blue-400">{'{date}'}</code>{' '}
                              <code className="text-blue-400">{'{domain}'}</code>
                            </p>
                          </div>

                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              onClick={cancelEdit}
                              className="border-slate-700"
                            >
                              Cancel
                            </Button>
                            <Button onClick={saveTemplate} disabled={isSaving}>
                              {isSaving ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
                              ) : (
                                <><Save className="mr-2 h-4 w-4" />Save Changes</>
                              )}
                            </Button>
                          </div>
                        </>
                      ) : (
                        /* ── VIEW MODE ── */
                        <>
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              System Prompt
                            </Label>
                            <pre className="bg-slate-950 p-4 rounded-lg text-sm text-slate-300 overflow-x-auto whitespace-pre-wrap break-words">
                              <code>{template.systemPrompt || 'No system prompt defined.'}</code>
                            </pre>
                          </div>

                          <div className="space-y-2">
                            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              User Prompt Template
                            </Label>
                            <pre className="bg-slate-950 p-4 rounded-lg text-sm text-slate-300 overflow-x-auto whitespace-pre-wrap break-words">
                              <code>{template.userPromptTemplate || 'No user prompt defined.'}</code>
                            </pre>
                          </div>

                          {template.outputSchema && (
                            <div className="space-y-2">
                              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                Output Schema
                              </Label>
                              <pre className="bg-slate-950 p-4 rounded-lg text-sm text-slate-300 overflow-x-auto whitespace-pre-wrap break-words">
                                <code>{JSON.stringify(template.outputSchema, null, 2)}</code>
                              </pre>
                            </div>
                          )}
                        </>
                      )}
                    </CardContent>
                  )}
                </Card>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}